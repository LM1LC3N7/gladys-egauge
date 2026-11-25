// -----------------------------------------------------------------------------
// The app end to end: the fake Gladys of the SDK, the fake meter of
// test/fixtures/meter.js, a virtual clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX_INTERVAL, PATHS, POLL_INTERVAL } from '../src/constants.js';
import { platformIdOf } from '../src/devices.js';
import { createMemoryStore } from '../src/store.js';
import { FP, NOW, OTHER_FP, PASSWORD, SERIAL, USERNAME, json, ws } from './fixtures/meter.js';
import { CONFIG, D, HOUR, MINUTE, SECOND, TRUSTED, created, setup, until } from './helpers/app.js';

const text = (status) => status?.message?.en ?? '';
const USE = platformIdOf({ name: 'use', type: 'P', did: null });
const GEN = platformIdOf({ name: 'gen', type: 'P', did: null });
const GRID = 'reg-0-power';
const SOLAR_PLUS = 'reg-2-power';
const GRID_MINUS = 'reg-3-power';
const KITCHEN = 'reg-4-power';
const LISTS = { consumption_registers: 'use, Kitchen', production_registers: 'gen' };
const ALLOWED = new Set(Object.values(PATHS));

// --- The certificate ---------------------------------------------------------------------------

test('first read without a confirmed certificate: nothing is sent, the fingerprint is shown', async () => {
  const t = await setup({ config: CONFIG });
  await t.start();
  assert.equal(t.meter.peers, 1, 'one TLS handshake');
  assert.equal(t.meter.requests.length, 0, 'not a byte written');
  assert.equal(t.gladys.fake.connectionStatus.connected, false);
  assert.match(text(t.gladys.fake.connectionStatus), /self-signed certificate/);
  assert.ok(text(t.gladys.fake.connectionStatus).includes(FP));
  assert.deepEqual(t.store.data.pins, {}, 'never learned by itself');
  assert.equal(t.app.outcome.err.code, 'certificate_unconfirmed');
  await t.wait(10 * MINUTE);
  assert.equal(t.meter.requests.length, 0);
  assert.deepEqual(t.store.data.pins, {});
  await t.app.stop();
});

test('"Trust the certificate": two clicks 3 s to 5 min apart, the same fingerprint both times', async () => {
  let shown = FP;
  const t = await setup({ config: CONFIG, probe: async () => shown });
  await t.start();
  const first = await t.app.trustCertificate();
  assert.match(first.en, /click again within 5 min/);
  assert.ok(first.en.includes(FP));
  // Too soon: a new first click.
  await t.advance(SECOND);
  assert.match((await t.app.trustCertificate()).en, /click again/);
  assert.deepEqual(t.store.data.pins, {});
  // Another certificate at the second click: nothing trusted.
  await t.advance(5 * SECOND);
  shown = OTHER_FP;
  assert.match((await t.app.trustCertificate()).en, /another certificate/);
  assert.deepEqual(t.store.data.pins, {});
  shown = FP;
  await t.app.trustCertificate();
  await t.advance(6 * MINUTE);
  assert.match((await t.app.trustCertificate()).en, /click again/, 'the first click expired');
  await t.advance(4 * SECOND);
  assert.match((await t.app.trustCertificate()).en, /Certificate trusted/);
  assert.equal(t.store.data.pins['192.168.1.30:443'], FP);
  await t.wait(POLL_INTERVAL);
  assert.ok(t.meter.count('/api/register') >= 1);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  await t.app.stop();
});

test('"Trust the certificate" never with a fingerprint typed, nor a /data unreadable or unwritable', async () => {
  const typed = await setup();
  await typed.start();
  assert.match((await typed.app.trustCertificate()).en, /fingerprint is typed/);
  await typed.app.stop();
  const store = createMemoryStore();
  store.broken = true;
  const t = await setup({ config: CONFIG, store });
  await t.start();
  assert.match((await t.app.trustCertificate()).en, /\/data cannot be read/);
  await t.app.stop();
  const store2 = createMemoryStore();
  const u = await setup({ config: CONFIG, store: store2 });
  await u.start();
  await u.app.trustCertificate();
  await u.advance(4 * SECOND);
  store2.failSave = true;
  assert.match((await u.app.trustCertificate()).en, /cannot be written/);
  assert.deepEqual(u.app.memory.pins, {});
  await u.app.stop();
});

test('a typed fingerprint: the only one taken; another certificate: nothing sent, shown', async () => {
  const t = await setup({ config: { ...CONFIG, certificate_fingerprint: OTHER_FP } });
  await t.start();
  assert.equal(t.meter.requests.length, 0);
  assert.match(text(t.gladys.fake.connectionStatus), /not the fingerprint typed/);
  assert.ok(text(t.gladys.fake.connectionStatus).includes(FP));
  await t.app.configUpdated({ ...CONFIG, certificate_fingerprint: FP.toLowerCase() });
  await t.wait(0);
  await t.wait(POLL_INTERVAL);
  assert.ok(t.meter.count('/api/register') >= 1);
  assert.equal(t.store.data.pins['192.168.1.30:443'], FP, 'kept in /data');
  await t.app.stop();
});

test('a certificate that changes after it was trusted: nothing sent, never learned again', async () => {
  const t = await setup();
  await t.start();
  // The field emptied: the pin in /data stays the authority.
  await t.app.configUpdated(CONFIG);
  await t.wait(POLL_INTERVAL);
  const before = t.meter.requests.length;
  t.meter.fingerprint = OTHER_FP;
  await t.wait(POLL_INTERVAL);
  await t.wait(HOUR);
  assert.equal(t.meter.requests.length, before, 'not a byte to another certificate');
  assert.equal(t.store.data.pins['192.168.1.30:443'], FP);
  assert.match(text(t.gladys.fake.connectionStatus), /not the one you trusted/);
  assert.ok(text(t.gladys.fake.connectionStatus).includes(OTHER_FP));
  await t.app.stop();
});

// --- The login and the reads -----------------------------------------------------------------

test('the digest login: the password never sent, only the documented paths, the token used again', async () => {
  const t = await setup({ config: { ...TRUSTED, ...LISTS } });
  await t.start();
  await t.wait(POLL_INTERVAL);
  await t.wait(POLL_INTERVAL);
  const sent = JSON.stringify(t.meter.requests);
  assert.ok(!sent.includes(PASSWORD), 'the password itself never leaves');
  for (const r of t.meter.requests) {
    assert.ok(ALLOWED.has(r.path), r.path);
    assert.ok(!/\/api\/(cmd|config)/.test(r.path), r.path);
    assert.equal(r.method === 'POST', r.path === PATHS.LOGIN, `${r.method} ${r.path}`);
  }
  const login = t.meter.requests.find((r) => r.path === PATHS.LOGIN);
  assert.equal(login.body.usr, USERNAME);
  assert.match(login.body.cnnc, /^[0-9a-f]{32}$/);
  assert.equal(t.meter.count(PATHS.LOGIN), 1, 'one login for three reads');
  assert.equal(t.meter.count('/api/register'), 3);
  assert.equal(t.meter.count('/api/sys/sn'), 3, 'identity at every read');
  // A new token after 8 minutes (the meter gives about 10), not sooner.
  await t.wait(6 * MINUTE);
  assert.equal(t.meter.count(PATHS.LOGIN), 1);
  await t.wait(2 * MINUTE);
  assert.equal(t.meter.count(PATHS.LOGIN), 2);
  await t.app.stop();
});

test('a token refused (meter rebooted): one new login in the same read; refused again: not a password refusal', async () => {
  const t = await setup();
  await t.start();
  t.meter.expire();
  await t.wait(POLL_INTERVAL);
  assert.equal(t.meter.count(PATHS.LOGIN), 2);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  t.meter.hook = (path) => (path === PATHS.REGISTERS ? json(403, { error: 'no' }) : undefined);
  t.meter.expire();
  await t.wait(POLL_INTERVAL);
  assert.equal(t.app.memory.refused, undefined, 'never a refusal of the password');
  assert.match(text(t.gladys.fake.connectionStatus), /read refused right after the login/);
  t.meter.hook = undefined;
  await t.wait(2 * POLL_INTERVAL);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  await t.app.stop();
});

test('an expired nonce: one new try; a second one is a protocol error, never a refusal', async () => {
  const t = await setup();
  let expired = 1;
  t.meter.hook = (path) =>
    path === PATHS.LOGIN && expired-- > 0 ? json(200, { error: 'Nonce expired.' }) : undefined;
  await t.start();
  assert.equal(t.meter.count(PATHS.UNAUTHORIZED), 2);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  t.meter.expire();
  t.meter.hook = (path) =>
    path === PATHS.LOGIN ? json(200, { error: 'Nonce expired.' }) : undefined;
  t.app.session.client.close();
  await t.wait(POLL_INTERVAL);
  assert.equal(t.app.memory.refused, undefined);
  assert.match(text(t.gladys.fake.connectionStatus), /not an answer of the eGauge WebAPI/);
  await t.app.stop();
});

test('a login refused: kept in /data, never tried again by itself; the test button and a new password lift it', async () => {
  // A fixed salt: the 8-bit tags of the two passwords differ (one in 256 would not).
  const t = await setup({
    config: { ...TRUSTED, password: 'wrong' },
    random: () => '0'.repeat(32),
  });
  await t.start();
  assert.ok(t.store.data.refused);
  assert.match(text(t.gladys.fake.connectionStatus), /refuses the user name or the password/);
  const logins = t.meter.count(PATHS.LOGIN);
  assert.equal(t.pending.size, 0, 'no read planned while refused');
  await t.wait(HOUR);
  assert.equal(t.meter.count(PATHS.LOGIN), logins, 'no automatic try');
  // The test button tries once (a read is due).
  await t.app.testConnection();
  assert.equal(t.meter.count(PATHS.LOGIN), logins + 1);
  await t.app.configUpdated(TRUSTED);
  await t.wait(0);
  assert.equal(t.store.data.refused, null);
  await t.wait(POLL_INTERVAL);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  assert.ok(!JSON.stringify(t.store.data).includes('wrong'));
  await t.app.stop();
});

test('a login answered with another error text is a refusal; HTTP 400 is not', async () => {
  const t = await setup();
  t.meter.loginReply = () => json(400, { error: 'Bad Request' });
  await t.start();
  assert.equal(t.app.memory.refused, undefined);
  t.meter.loginReply = () => json(200, { error: 'Invalid credentials.' });
  await t.wait(10 * MINUTE);
  assert.ok(t.app.memory.refused);
  await t.app.stop();
});

test('429 and 5xx: a pause kept in /data, Retry-After taken, bounded', async () => {
  const t = await setup();
  t.meter.hook = (path) =>
    path === PATHS.SERIAL ? json(429, { error: 'slow' }, { 'retry-after': '600' }) : undefined;
  await t.start();
  assert.equal(t.store.data.pause.code, 'rate_limited');
  assert.match(text(t.gladys.fake.connectionStatus), /paused for 10 min/);
  const reads = t.meter.count(PATHS.SERIAL);
  await t.wait(9 * MINUTE);
  assert.equal(t.meter.count(PATHS.SERIAL), reads);
  t.meter.hook = undefined;
  await t.wait(MINUTE + SECOND);
  assert.equal(t.meter.count(PATHS.SERIAL), reads + 1, 'the first read after 10 min');
  assert.equal(t.store.data.pause, null);
  await t.app.stop();
});

test('pace: one read every 30 s whatever asks; the time of the last read survives a restart', async () => {
  const store = createMemoryStore();
  const t = await setup({ store });
  await t.start();
  await t.app.configUpdated(TRUSTED);
  await t.app.connected(async () => TRUSTED);
  await t.app.scan();
  await t.app.testConnection();
  await t.wait(POLL_INTERVAL - SECOND);
  assert.equal(t.meter.count('/api/register'), 1);
  await t.wait(SECOND);
  assert.equal(t.meter.count('/api/register'), 2);
  await t.app.stop();
  const u = await setup({ store, meter: t.meter, now: t.clock.now + 10 * SECOND });
  await u.start();
  assert.equal(t.meter.count('/api/register'), 2, 'not sooner after a restart');
  await u.wait(20 * SECOND);
  assert.equal(t.meter.count('/api/register'), 3);
  await u.app.stop();
});

test('getConfig failing in connected: tried again, the status says so, then it reads', async () => {
  const t = await setup({ connect: true });
  let fail = 1;
  const run = t.app.connected(async () => {
    if (fail-- > 0) throw new Error('down');
    return TRUSTED;
  });
  await run;
  assert.match(text(t.gladys.fake.connectionStatus), /could not be read from Gladys/);
  await t.wait(5 * SECOND);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  await t.app.stop();
});

// --- Devices and values --------------------------------------------------------------------------

test('discovery: one device per register of a supported type; the lists give the energy features', async () => {
  const t = await setup({ config: { ...TRUSTED, ...LISTS } });
  await t.start();
  const devices = Object.fromEntries(
    t.gladys.fake.discoveredDevices.map((d) => [d.external_id, d]),
  );
  const keys = (id) => devices[D(id)].features.map((f) => f.external_id.split(':').at(-1)).sort();
  assert.deepEqual(keys(USE), [
    'consumption_index',
    'consumption_index_30min',
    'consumption_power',
  ]);
  assert.deepEqual(keys(GEN), ['production_index', 'production_index_30min', 'production_power']);
  assert.deepEqual(keys(GRID), ['power'], 'a net register not listed: no energy');
  assert.deepEqual(keys(KITCHEN), [
    'consumption_index',
    'consumption_index_30min',
    'consumption_power',
  ]);
  assert.deepEqual(keys(SOLAR_PLUS), ['lifetime', 'power']);
  assert.deepEqual(keys(GRID_MINUS), ['lifetime', 'power']);
  assert.deepEqual(keys('reg-5-voltage'), ['voltage']);
  assert.deepEqual(keys('reg-6-temperature'), ['temperature']);
  assert.equal(Object.keys(devices).length, 9, 'Humidity not offered');
  assert.equal(devices[D(USE)].name, 'eGauge use');
  const index = devices[D(USE)].features.find((f) => f.external_id.endsWith(':consumption_index'));
  const half = devices[D(USE)].features.find((f) => f.external_id.endsWith('_30min'));
  assert.equal(half.energy_parent_id, index.id);
  assert.match(text(t.gladys.fake.connectionStatus), /1 register\(s\) of another type/);
  await t.app.stop();
});

test('values: powers signed or floored, a "-" register turned positive, counters from the raw W·s', async () => {
  const devices = [
    created(USE, { role: 'consumption' }),
    created(GEN, { role: 'production' }),
    created(GRID),
    created(GRID_MINUS),
    created('reg-5-voltage'),
  ];
  const t = await setup({ devices, config: { ...TRUSTED, ...LISTS } });
  t.meter.reg('gen').rate = -4;
  await t.start();
  assert.deepEqual(t.statesOf(USE, 'consumption_power'), [1802]);
  assert.deepEqual(t.statesOf(USE, 'consumption_index'), [12000]);
  assert.deepEqual(t.statesOf(GEN, 'production_power'), [0], 'standby draw shown as 0');
  assert.deepEqual(t.statesOf(GEN, 'production_index'), [8000]);
  assert.deepEqual(t.statesOf(GRID, 'power'), [-698]);
  assert.deepEqual(t.statesOf(GRID_MINUS, 'power'), [698]);
  assert.deepEqual(t.statesOf(GRID_MINUS, 'lifetime'), [3000]);
  assert.deepEqual(t.statesOf('reg-5-voltage', 'voltage'), [231.4]);
  assert.deepEqual(t.statesOf(USE, 'consumption_index_30min'), []);
  await t.app.stop();
});

test('a row is published once; the counters once a minute; a row 2 h old never', async () => {
  const t = await setup({
    devices: [created(USE, { role: 'consumption' })],
    config: { ...TRUSTED, ...LISTS },
  });
  t.meter.rowAt = NOW;
  await t.start();
  await t.wait(POLL_INTERVAL);
  assert.deepEqual(t.statesOf(USE, 'consumption_power'), [1802], 'the same row: not again');
  t.meter.rowAt = undefined;
  t.meter.run(60);
  // The SDK sends a state only when it changed: the values move.
  t.meter.reg('use').rate = 1900;
  await t.wait(POLL_INTERVAL);
  assert.equal(t.statesOf(USE, 'consumption_power').length, 2);
  assert.equal(t.statesOf(USE, 'consumption_index').length, 2);
  t.meter.rowAt = t.clock.now - 3 * HOUR;
  t.meter.reg('use').rate = 2000;
  await t.wait(INDEX_INTERVAL);
  assert.equal(t.statesOf(USE, 'consumption_power').length, 2);
  assert.match(text(t.gladys.fake.connectionStatus), /more than 2 hours old/);
  await t.app.stop();
});

test('a lifetime counter: a drop held, never confirmed by time; accepted only in two clicks', async () => {
  const devices = [created(SOLAR_PLUS)];
  const t = await setup({ devices });
  await t.start();
  assert.deepEqual(t.statesOf(SOLAR_PLUS, 'lifetime'), [8100]);
  t.meter.reg('Solar+').cumul = ws(10);
  await t.wait(INDEX_INTERVAL);
  await t.wait(2 * HOUR);
  assert.deepEqual(t.statesOf(SOLAR_PLUS, 'lifetime'), [8100], 'never 10, never by time');
  assert.match(text(t.gladys.fake.connectionStatus), /dropped from 8100 to 10 kWh/);
  assert.ok(
    t.gladys.fake.transports.some((b) => b.device_external_id === D(SOLAR_PLUS) && b.degraded),
  );
  const first = await t.app.acceptHeld();
  assert.match(first.en, /Click again/);
  await t.advance(5 * SECOND);
  const second = await t.app.acceptHeld();
  assert.match(second.en, /Accepted/);
  await t.wait(POLL_INTERVAL);
  assert.equal(t.statesOf(SOLAR_PLUS, 'lifetime').at(-1), 10);
  await t.app.stop();
});

test('a net register counted: a small drop (standby at night) neither published nor held; a large one held', async () => {
  const devices = [created(GEN, { role: 'production' })];
  const t = await setup({ devices, config: { ...TRUSTED, ...LISTS } });
  await t.start();
  t.meter.reg('gen').cumul -= ws(0.05);
  await t.wait(INDEX_INTERVAL);
  assert.deepEqual(t.statesOf(GEN, 'production_index'), [8000]);
  assert.equal(t.app.heldList().length, 0, 'not held');
  t.meter.reg('gen').cumul += ws(1.05);
  await t.wait(HOUR);
  assert.equal(t.statesOf(GEN, 'production_index').at(-1), 8001);
  t.meter.reg('gen').cumul -= ws(5);
  await t.wait(INDEX_INTERVAL);
  assert.equal(t.app.heldList().length, 1, 'a real drop is held');
  await t.app.stop();
});

test('a counter is never 0, and never published while /data cannot be written', async () => {
  const store = createMemoryStore();
  const devices = [created(SOLAR_PLUS)];
  const t = await setup({ devices, store });
  t.meter.reg('Solar+').cumul = 0n;
  await t.start();
  assert.deepEqual(t.statesOf(SOLAR_PLUS, 'lifetime'), []);
  t.meter.reg('Solar+').cumul = ws(100);
  t.meter.reg('Solar+').rate = 7;
  store.failSave = true;
  await t.wait(INDEX_INTERVAL);
  assert.deepEqual(t.statesOf(SOLAR_PLUS, 'lifetime'), []);
  assert.deepEqual(t.statesOf(SOLAR_PLUS, 'power').length, 2, 'the power still goes');
  store.failSave = false;
  await t.wait(INDEX_INTERVAL);
  assert.deepEqual(t.statesOf(SOLAR_PLUS, 'lifetime'), [100]);
  await t.app.stop();
});

test('/data unreadable: no counter, the pin of /data unknown so a typed fingerprint is needed', async () => {
  const store = createMemoryStore();
  store.broken = true;
  const t = await setup({ devices: [created(SOLAR_PLUS)], store });
  await t.start();
  assert.deepEqual(t.statesOf(SOLAR_PLUS, 'lifetime'), []);
  assert.match(text(t.gladys.fake.connectionStatus), /\/data cannot be read/);
  assert.equal(t.app.identityState, 'unreadable');
  store.broken = false;
  await t.wait(INDEX_INTERVAL);
  assert.deepEqual(t.statesOf(SOLAR_PLUS, 'lifetime'), [8100]);
  await t.app.stop();
});

test('another meter at the address: nothing published until accepted in two clicks', async () => {
  const t = await setup({ devices: [created(GRID)] });
  await t.start();
  assert.equal(t.statesOf(GRID, 'power').length, 1);
  t.meter.serial = 'G99999';
  t.meter.run(30);
  t.meter.reg('Grid').rate = 10;
  await t.wait(POLL_INTERVAL);
  assert.equal(t.statesOf(GRID, 'power').length, 1);
  assert.match(text(t.gladys.fake.connectionStatus), /Another eGauge meter/);
  await t.app.acceptHeld();
  await t.advance(4 * SECOND);
  assert.match((await t.app.acceptHeld()).en, /New meter accepted/);
  await t.wait(POLL_INTERVAL);
  assert.deepEqual(t.statesOf(GRID, 'power').at(-1), 10);
  await t.app.stop();
});

test('a serial number that cannot be read: nothing published from that read, never "another meter"', async () => {
  const t = await setup({ devices: [created(GRID)] });
  t.meter.hook = (path) => (path === PATHS.SERIAL ? json(200, { result: '' }) : undefined);
  await t.start();
  assert.deepEqual(t.statesOf(GRID, 'power'), []);
  assert.match(text(t.gladys.fake.connectionStatus), /serial number could not be checked/);
  assert.equal(t.store.data.identity, null);
  await t.app.stop();
});

test('the user name, the password, the token and the serial number are never in the logs, /data, statuses', async () => {
  const t = await setup({ devices: [created(GRID)], config: { ...TRUSTED, ...LISTS } });
  await t.start();
  await t.wait(POLL_INTERVAL);
  t.meter.serial = 'G55555';
  await t.wait(POLL_INTERVAL);
  await t.app.configUpdated({ ...TRUSTED, password: 'bad-one' });
  await t.wait(POLL_INTERVAL);
  await t.app.stop();
  const all = JSON.stringify([
    t.lines,
    t.store.data,
    t.gladys.fake.connectionStatuses,
    t.gladys.fake.discoveredDevices,
    t.gladys.fake.states,
  ]);
  for (const secret of [USERNAME, PASSWORD, 'bad-one', SERIAL, 'G55555', 'eyJ0b2si']) {
    assert.ok(!all.includes(secret), secret);
  }
});

test('the lists: a name in both, or not found, is said; nothing counted from a wrong list', async () => {
  const t = await setup({
    config: { ...TRUSTED, consumption_registers: 'use, Nope', production_registers: 'gen' },
  });
  await t.start();
  assert.match(text(t.gladys.fake.connectionStatus), /not found on the meter.*"Nope"/);
  await t.app.configUpdated({
    ...TRUSTED,
    consumption_registers: 'use',
    production_registers: 'use',
  });
  await t.wait(POLL_INTERVAL);
  assert.match(text(t.gladys.fake.connectionStatus), /both the consumption and the production/);
  assert.equal(t.app.config.consumption.length, 0);
  await t.app.stop();
});

test('a slow meter: the test button answers within 25 s; nothing is read after a stop', async () => {
  const t = await setup();
  await t.start();
  let release;
  t.meter.hook = (path) =>
    path === PATHS.SERIAL ? new Promise((resolve) => (release = resolve)) : undefined;
  // The read of the timer would hold the fake clock: the button makes it.
  t.app.timers.clearTimeout(t.app.timer);
  t.app.timer = undefined;
  t.clock.now += POLL_INTERVAL;
  const answer = t.app.testConnection();
  await t.advance(25 * SECOND);
  assert.match((await answer).en, /slow to answer/);
  // Stopped while the read hangs: its answer, late, publishes nothing.
  const stopped = t.app.stop();
  const stopWait = () => [...t.pending.values()].some((p) => p.at === t.clock.now + 5 * SECOND);
  await until(stopWait);
  await t.advance(5 * SECOND);
  await stopped;
  release(json(200, { result: SERIAL }));
  await t.app.idle();
  const count = t.meter.requests.length;
  await t.wait(HOUR);
  assert.equal(t.meter.requests.length, count, 'nothing after the stop');
  assert.equal(t.pending.size, 0, 'no timer left');
});

// --- Review r1 -------------------------------------------------------------------------------------

test('an account without "view settings": the registers are read, the meter identified by its certificate', async () => {
  const t = await setup({ devices: [created(GRID)] });
  t.meter.viewSettings = false;
  await t.start();
  assert.deepEqual(t.statesOf(GRID, 'power'), [-698]);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  assert.match(text(t.gladys.fake.connectionStatus), /identified by the certificate/);
  assert.equal(t.store.data.identity, null);
  assert.match(t.store.data.identityPin, /^[0-9a-f]{64}$/);
  assert.equal(t.app.memory.refused, undefined);
  // No login per read: the serial number is asked again with a new token only.
  t.meter.reg('Grid').rate = -500;
  await t.wait(POLL_INTERVAL);
  await t.wait(POLL_INTERVAL);
  assert.equal(t.meter.count(PATHS.LOGIN), 1);
  assert.equal(t.meter.count(PATHS.SERIAL), 1);
  assert.equal(t.statesOf(GRID, 'power').at(-1), -500);
  // Another certificate, typed by the user: another meter until accepted.
  t.meter.fingerprint = OTHER_FP;
  await t.app.configUpdated({ ...TRUSTED, certificate_fingerprint: OTHER_FP });
  t.meter.reg('Grid').rate = -400;
  await t.wait(POLL_INTERVAL);
  assert.match(text(t.gladys.fake.connectionStatus), /Another eGauge meter/);
  assert.equal(t.statesOf(GRID, 'power').at(-1), -500);
  await t.app.acceptHeld();
  await t.advance(4 * SECOND);
  assert.match((await t.app.acceptHeld()).en, /New meter accepted/);
  await t.wait(POLL_INTERVAL);
  assert.equal(t.statesOf(GRID, 'power').at(-1), -400);
  await t.app.stop();
});

test('a serial number read again: the certificate becomes its fallback identity', async () => {
  const t = await setup({ devices: [created(GRID)] });
  await t.start();
  assert.match(t.store.data.identity, /^[0-9a-f]{64}$/);
  assert.match(t.store.data.identityPin, /^[0-9a-f]{64}$/);
  t.meter.viewSettings = false;
  t.meter.reg('Grid').rate = 1;
  await t.wait(POLL_INTERVAL);
  assert.equal(t.statesOf(GRID, 'power').at(-1), 1, 'same certificate: the same meter');
  await t.app.stop();
});

test('a 401 of the login with an expired nonce is a new try, never a refused password', async () => {
  const t = await setup();
  let once = true;
  t.meter.hook = (path) => {
    if (path === PATHS.LOGIN && once) {
      once = false;
      return json(401, { error: 'Nonce expired.' });
    }
    return undefined;
  };
  await t.start();
  assert.equal(t.app.memory.refused, undefined);
  assert.equal(t.meter.count(PATHS.UNAUTHORIZED), 2);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  await t.app.stop();
});

test('a refused login: no read even when one is asked directly; the time of a read in /data before it', async () => {
  const t = await setup({ config: { ...TRUSTED, password: 'wrong' } });
  await t.start();
  const logins = t.meter.count(PATHS.LOGIN);
  t.clock.now += HOUR;
  await t.app.tick();
  assert.equal(t.meter.count(PATHS.LOGIN), logins, 'read() checks the refusal too');
  await t.app.stop();
  // Pinned already (a typed fingerprint would save /data in checkPeer anyway).
  const u = await setup({
    config: CONFIG,
    store: createMemoryStore({ pins: { '192.168.1.30:443': FP } }),
  });
  let kept;
  u.meter.hook = (path) => {
    if (path === PATHS.SERIAL && kept === undefined) kept = u.store.data.lastAttemptAt;
    return undefined;
  };
  await u.start();
  assert.equal(kept, NOW, 'lastAttemptAt written before the first request');
  await u.app.stop();
});

test('every start forgets the states Gladys was sent (a restarted Gladys gets them again)', async () => {
  const t = await setup();
  let forgotten = 0;
  const original = t.gladys.forgetPublishedStates?.bind(t.gladys);
  t.gladys.forgetPublishedStates = () => {
    forgotten += 1;
    return original?.();
  };
  await t.start();
  await t.app.configUpdated(TRUSTED);
  assert.equal(forgotten, 2);
  await t.app.stop();
});

test('a small drop of a "+" register is held (only a net register may dip)', async () => {
  const t = await setup({ devices: [created(SOLAR_PLUS)] });
  await t.start();
  t.meter.reg('Solar+').cumul -= ws(0.05);
  await t.wait(INDEX_INTERVAL);
  assert.equal(t.app.heldList().length, 1);
  await t.app.stop();
});

test('values outside the declared bounds are not published', async () => {
  const t = await setup({ devices: [created(GRID), created('reg-6-temperature')] });
  t.meter.reg('Grid').rate = 1e9;
  t.meter.reg('Attic').rate = 5000;
  await t.start();
  assert.deepEqual(t.statesOf(GRID, 'power'), []);
  assert.deepEqual(t.statesOf('reg-6-temperature', 'temperature'), []);
  t.meter.reg('Attic').rate = 20;
  await t.wait(POLL_INTERVAL);
  assert.deepEqual(t.statesOf('reg-6-temperature', 'temperature'), [20]);
  await t.app.stop();
});

test('a listed register that counts nothing is said', async () => {
  const t = await setup({
    config: { ...TRUSTED, consumption_registers: 'use, L1 Voltage', production_registers: 'Grid' },
  });
  t.meter.reg('Grid').cumul = -ws(10);
  await t.start();
  assert.match(text(t.gladys.fake.connectionStatus), /counted nowhere[^.]*"L1 Voltage", "Grid"/);
  await t.app.stop();
});

test('300 registers: at most 250 states a minute; badges in calls of 100, tried again after a failure', async () => {
  const meter = (await setup({ connect: false })).meter;
  meter.regs = Array.from({ length: 300 }, (_, i) => ({
    name: `C${i}`,
    type: 'P',
    idx: i,
    did: i,
    rate: 100 + i,
    cumul: ws(1000 + i),
  }));
  const devices = meter.regs.map((r) => created(`reg-${r.did}-power`, { keys: ['power'] }));
  const t = await setup({ devices, meter });
  let fail = true;
  const publish = t.gladys.publishTransports.bind(t.gladys);
  const calls = [];
  t.gladys.publishTransports = async (list) => {
    calls.push(list.length);
    if (fail) {
      fail = false;
      throw new Error('down');
    }
    return publish(list);
  };
  await t.start();
  const powers = () =>
    t.gladys.fake.states.filter((s) => s.device_feature_external_id.endsWith(':power')).length;
  assert.ok(powers() <= 250, `${powers()} states`);
  assert.ok(calls.every((n) => n <= 100));
  for (const r of meter.regs) r.rate += 1;
  await t.wait(POLL_INTERVAL);
  assert.ok(powers() <= 250, 'nothing more within the minute');
  // The budget counts a minute and a margin (65 s): the read at 90 s sends again.
  await t.wait(2 * POLL_INTERVAL);
  assert.ok(powers() > 250);
  assert.equal(new Set(t.gladys.fake.transports.map((b) => b.device_external_id)).size, 300);
  await t.app.stop();
});
