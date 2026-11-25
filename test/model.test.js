// -----------------------------------------------------------------------------
// What the answers of the meter say (src/egauge/model.js), the devices made
// of them (src/devices.js) and the form (src/config.js): strict, bounded.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseHost, parseRegisterList } from '../src/config.js';
import { accumulationOf, kwhOf, platformIdOf, sampleOf } from '../src/devices.js';
import { digestHash } from '../src/egauge/client.js';
import {
  challengeOf,
  cumulOf,
  loginReplyOf,
  parseRegisters,
  serialOf,
  timeOf,
} from '../src/egauge/model.js';
import { IndexGuard } from '../src/guard.js';
import { COUNTER_LIMITS } from '../src/constants.js';
import { createMeter, ws } from './fixtures/meter.js';

const body = (value) => Buffer.from(JSON.stringify(value));

test('the register answer: rows mapped by increasing index, whatever the order of the list', () => {
  const meter = createMeter();
  meter.order = (sorted) => [...sorted].reverse();
  const answer = parseRegisters(body(meter.registerAnswer()));
  const grid = answer.registers.find((r) => r.name === 'Grid');
  assert.equal(grid.cumul, ws(4000));
  assert.equal(grid.did, 0);
  assert.equal(grid.virtual, false);
  assert.equal(answer.registers.find((r) => r.name === 'use').virtual, true);
  assert.equal(answer.at, meter.clock.now);
});

test('the register answer: a value that is not a decimal integer is unknown, never 0', () => {
  assert.equal(cumulOf('12'), 12n);
  assert.equal(cumulOf({ v: '-5', peak: { rate: 1, dt: '1' } }), -5n);
  for (const bad of ['', ' 1', '1.5', '1e3', null, 3, '99999999999999999999', 'NaN']) {
    assert.equal(cumulOf(bad), undefined, String(bad));
  }
  assert.equal(cumulOf('9223372036854775808'), undefined, 'beyond 64 bits');
  assert.equal(kwhOf(undefined), undefined);
  assert.equal(kwhOf(ws(1.5)), 1.5);
  assert.equal(kwhOf(-ws(2), -1), 2);
});

test('the register answer: refused when it is not one of the WebAPI', () => {
  const meter = createMeter();
  const good = meter.registerAnswer();
  const bad = [
    'not json',
    { error: 'denied' },
    { registers: 'x' },
    { ...good, ranges: [] },
    { ...good, ranges: [{ ts: '1', rows: [['1']] }] },
    { ...good, registers: [...good.registers.slice(1), { ...good.registers[1] }] },
    { ...good, registers: good.registers.map((r, i) => (i === 0 ? { ...r, idx: -1 } : r)) },
    {
      registers: Array.from({ length: 1001 }, (_, i) => ({ name: `r${i}`, type: 'P', idx: i })),
      ranges: [{ ts: '1', rows: [[]] }],
    },
  ];
  for (const value of bad) {
    assert.throws(
      () => parseRegisters(typeof value === 'string' ? Buffer.from(value) : body(value)),
      /./,
    );
  }
});

test('the register answer: names with a control character skipped and counted; prototype keys harmless', () => {
  const answer = parseRegisters(
    body({
      ts: '1700000000',
      registers: [
        { name: 'a\nb', type: 'P', idx: 0, did: 0 },
        { name: '__proto__', type: 'P', idx: 1, did: 1, rate: 5 },
        { name: 'ok', type: 'P', idx: 2, did: 2, rate: 'x' },
      ],
      ranges: [{ ts: '1700000000.5', delta: 1, rows: [['1', '2', '3']] }],
    }),
  );
  assert.equal(answer.skipped, 1);
  assert.deepEqual(
    answer.registers.map((r) => [r.name, r.cumul, r.rate]),
    [
      ['__proto__', 2n, 5],
      ['ok', 3n, undefined],
    ],
  );
  assert.equal(answer.at, 1_700_000_000_500);
  assert.equal(timeOf('17'), undefined);
});

test('the digest of the WebAPI: MD5(MD5(usr:rlm:pwd):nnc:cnnc), as egauge-python', () => {
  // Computed apart (Python hashlib), as egauge-python's JWTAuth does.
  assert.equal(
    digestHash({ usr: 'owner', rlm: 'eGauge Administration', pwd: 'secret', nnc: 'n', cnnc: 'c' }),
    '660becd36ecd46e8a74572f457fbdf0e',
  );
  assert.notEqual(
    digestHash({ usr: 'u', rlm: 'r', pwd: 'p', nnc: 'n', cnnc: 'c' }),
    digestHash({ usr: 'u', rlm: 'r', pwd: 'q', nnc: 'n', cnnc: 'c' }),
  );
});

test('the login answers: a token, an expired nonce, a refusal, or not an answer', () => {
  assert.deepEqual(loginReplyOf(body({ jwt: 'a.b.c' })), { jwt: 'a.b.c' });
  assert.deepEqual(loginReplyOf(body({ error: 'Nonce expired.' })), { nonceExpired: true });
  assert.deepEqual(loginReplyOf(body({ error: 'Invalid' })), { refused: true });
  assert.throws(() => loginReplyOf(body({ jwt: 'a b\r\nX: y' })), /No token/);
  assert.throws(() => loginReplyOf(body([])), /Not a login/);
  assert.deepEqual(challengeOf(body({ rlm: 'R', nnc: 'N' })), { rlm: 'R', nnc: 'N' });
  assert.throws(() => challengeOf(body({ rlm: 'R\n', nnc: 'N' })), /challenge/);
  assert.equal(serialOf(body({ result: 'G10400' })), 'G10400');
  assert.equal(serialOf(body({ result: 'G 1' })), undefined);
  assert.equal(serialOf(Buffer.from('x')), undefined);
});

test('the platform ids: the database column of a physical register, a hash of the name of a virtual one', () => {
  assert.equal(platformIdOf({ name: 'Grid', type: 'P', did: 0 }), 'reg-0-power');
  assert.equal(platformIdOf({ name: 'Grid', type: 'V', did: 0 }), 'reg-0-voltage');
  assert.match(platformIdOf({ name: 'a.b:c', type: 'P', did: null }), /^virt-[0-9a-f]{16}-power$/);
  assert.equal(platformIdOf({ name: 'H', type: 'h', did: 3 }), undefined);
  assert.equal(accumulationOf({ name: 'Solar+', virtual: false }), 'positive');
  assert.equal(accumulationOf({ name: 'Grid-', virtual: false }), 'negative');
  assert.equal(accumulationOf({ name: 'Load|', virtual: false }), 'absolute');
  assert.equal(accumulationOf({ name: 'x+', virtual: true }), 'net');
  const s = sampleOf(
    { name: 'Grid-', type: 'P', did: 3, virtual: false, rate: -10, cumul: -ws(5) },
    { consumption: [], production: ['Grid-'] },
  );
  assert.deepEqual([s.role, s.power, s.counter], ['production', 10, 5]);
});

test('the form: address, account, lists', () => {
  assert.deepEqual(parseHost('https://192.168.1.30:8443/'), { host: '192.168.1.30', port: 8443 });
  assert.deepEqual(parseHost('http://192.168.1.30'), { error: 'http' });
  assert.deepEqual(parseHost('https://h/api/cmd'), { error: 'invalid' });
  assert.deepEqual(parseHost('192.168.1.255'), { error: 'invalid' });
  assert.deepEqual(parseHost('224.0.0.1'), { error: 'invalid' });
  assert.deepEqual(parseRegisterList(' use ,Kitchen,, use'), { names: ['use', 'Kitchen'] });
  assert.deepEqual(parseRegisterList('a\nb'), { error: 'invalid' });
  const missing = normalizeConfig({ address: 'x.local', password: 'p' });
  assert.equal(missing.usernameInvalid, true, 'a password without a user name is refused');
  const empty = normalizeConfig({ address: 'x.local', username: 'u', password: '' });
  assert.equal(empty.passwordInvalid, true);
  const ok = normalizeConfig({
    address: 'x.local',
    username: ' u ',
    password: ' p ',
    consumption_registers: 'use',
    production_registers: 'gen',
  });
  assert.deepEqual(
    [ok.username, ok.password, ok.consumption, ok.production],
    ['u', ' p ', ['use'], ['gen']],
  );
});

test('the guard never takes 0 nor a negative value, even as a first value', () => {
  const guard = new IndexGuard(undefined, undefined, 0, COUNTER_LIMITS);
  assert.equal(guard.accept(0, 0), false);
  assert.equal(guard.accept(-1, 0), false);
  assert.equal(guard.accept(5, 0), true);
});
