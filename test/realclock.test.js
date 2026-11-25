// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local HTTPS server playing the meter: the reads really start, at 0,
// the interval and twice the interval, with a bounded number of timers; the
// period is measured on the method that decides. Time sped up 20 times (30 s
// are 1.5 s), but the real clock: it moves between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EgaugeApp } from '../src/app.js';
import { PATHS, POLL_INTERVAL } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { PASSWORD, USERNAME, createMeter } from './fixtures/meter.js';
import { measurePeriod, realClock, spyOn } from './helpers/realclock.js';
import { meterServer } from './helpers/server.js';

const SPEED = 20;

test('real clock x20 over HTTPS: reads at 0, the interval and twice the interval; timers bounded', async (t) => {
  const meter = createMeter({ clock: { now: Date.now() } });
  const srv = await meterServer(meter);
  t.after(() => srv.close());
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ selector: 'egauge', config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new EgaugeApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
  });
  // Stopped even when an assertion fails: no timer keeps the runner alive.
  t.after(async () => {
    await app.stop().catch(() => {});
    clock.close();
  });
  const spy = spyOn(app, 'poll', clock);
  await app.start({
    address: `127.0.0.1:${srv.port}`,
    username: USERNAME,
    password: PASSWORD,
    certificate_fingerprint: meter.fingerprint,
  });
  await measurePeriod(spy, { count: 3, period: POLL_INTERVAL });
  await app.idle();
  await app.stop();
  const reads = srv.received.filter((r) => r.path === PATHS.REGISTERS).length;
  assert.ok(reads >= 3 && reads <= 4, `${reads} reads`);
  assert.equal(srv.received.filter((r) => r.path === PATHS.LOGIN).length, 1, 'one token');
  assert.ok(clock.timersSet <= 12, `${clock.timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
