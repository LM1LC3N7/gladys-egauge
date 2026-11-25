// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, the fake meter of
// test/fixtures/meter.js and a virtual clock that moves at every read (1 µs),
// so that a decision reading the clock twice is caught. The wall clock may be
// moved apart (`wall.offset`: NTP setting the clock).
// -----------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EgaugeApp } from '../../src/app.js';
import { CATALOG, buildDevice, kindOfPlatform } from '../../src/devices.js';
import { createMemoryStore } from '../../src/store.js';
import { FP, HOST, NOW, PASSWORD, USERNAME, createMeter } from '../fixtures/meter.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'egauge';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const D = (platformId) => `ext:${SELECTOR}:egauge:${platformId}`;
export const F = (platformId, key) => `${D(platformId)}:${key}`;
export const CONFIG = { address: HOST, username: USERNAME, password: PASSWORD };
/** The configuration with the certificate typed: the usual start of a test. */
export const TRUSTED = { ...CONFIG, certificate_fingerprint: FP };

/** Waits (real time, bounded) for `check()` to be true: never spins without end. */
export async function until(check, ms = 5000) {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) assert.fail(`condition not met within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * The device of a platform id as the user created it (`keys`, default every
 * feature of its kind without a role, or of `role`); `values`: `{ key: {
 * value, at } }` Gladys holds.
 */
export function created(
  platformId,
  { keys, values = {}, id = `device-${platformId}-1`, role, name = 'R' } = {},
) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const kind = kindOfPlatform(platformId);
  const all = CATALOG[kind].filter((e) => (e.role ?? undefined) === role).map((e) => e.key);
  const device = buildDevice(gladys, { kind, platformId, name }, new Set(keys ?? all));
  device.id = id;
  for (const [key, { value, at }] of Object.entries(values)) {
    const feature = device.features.find((f) => f.external_id === F(platformId, key));
    feature.last_value = value;
    feature.last_value_changed = new Date(at).toISOString();
  }
  return device;
}

export async function setup({
  devices: known = [],
  store,
  now = NOW,
  meter,
  config = TRUSTED,
  random,
  probe,
  wall = { offset: 0 },
  connect = true,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: known });
  if (connect) await gladys.connect();
  const { clock, timers, advance, pending } = createFakeClock(now);
  const device = meter ?? createMeter({ clock });
  device.clock = clock;
  let drift = 0;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const kept = store ?? createMemoryStore();
  const app = new EgaugeApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.now + wall.offset,
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store: kept,
    request: device.request,
    probe: probe ?? (async () => device.fingerprint),
    ...(random ? { random } : {}),
  });
  const start = async (cfg = config) => {
    await app.start(cfg);
    await advance(0);
    await app.idle();
  };
  const wait = async (ms) => {
    await advance(ms);
    await app.idle();
  };
  /** The states published to one feature (values only). */
  const statesOf = (platformId, key) =>
    gladys.fake.states
      .filter((s) => s.device_feature_external_id === F(platformId, key))
      .map((s) => s.state);
  return {
    app,
    gladys,
    clock,
    store: kept,
    meter: device,
    start,
    wait,
    advance,
    pending,
    lines,
    statesOf,
  };
}
