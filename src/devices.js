// -----------------------------------------------------------------------------
// The Gladys devices of an eGauge meter and their states. Pure.
//
// One Gladys device per register of a supported type, its platform id
// (forever, in the external id `ext:<selector>:egauge:<platform id>`):
//   reg-<did>-<kind>      a physical register: its database column `did`,
//                         which "remains the same" when the register is
//                         renamed (WebAPI); the kind is part of the id, so a
//                         register whose type changes is another device
//   virt-<hash>-<kind>    a virtual register (no `did`): 16 hex digits of the
//                         SHA-256 of its name
// The kinds: `power` (type code P), `voltage` (V), `current` (I), `frequency`
// (F), `temperature` (T). Other types are not offered (counted in the status).
//
// The energy (type P only). The meter accumulates each register in W·s; the
// value read is `raw` (counted from the creation of its database, never moved
// by a new "epoch" set in the meter), turned into kWh here. The suffix of a
// physical register name says what it accumulates (WebAPI glossary): `+` the
// positive power only, `-` the negative power only, `|` the absolute value,
// no suffix the NET power (it may go up and down). So:
// - a register the user lists as consumption: `energy-sensor` / `index` (with
//   its `thirty-minutes-consumption` declared, the core fills it) and
//   `energy-sensor` / `power`;
// - a register the user lists as production: `energy-production-sensor` /
//   `index` (with `thirty-minutes-production`) and `energy-production-sensor`
//   / `power` (never below 0: the standby draw of an inverter at night is 0);
// - any other power register: its power as ONE signed plain sensor, and, for
//   a `+`, `-` or `|` register only, a plain "lifetime" counter (kWh in the
//   name, not counted by the energy monitoring). A net register not listed
//   has no energy feature: a net value that goes down is no lifetime counter.
// A `-` register accumulates negative values: its index and power are shown
// with the sign turned (what was exported, positive). Every lifetime counter
// (index or plain) passes the guard (src/guard.js, src/app.js): never 0,
// never a drop nor a jump published without the user.
//
// Units: only the ones the core lists for the category
// (DEVICE_FEATURE_UNITS_BY_CATEGORY), none for `unknown` (in the name).
//
// The features follow what the meter showed and the lists of the user: the
// set only grows, and always holds the features of the created device, so a
// device published again never loses one (an "Update" in Discovery would
// drop its history).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { COUNTER_LIMITS, ENERGY_MAX, EXTERNAL_ID_TYPE, POWER_MAX } from './constants.js';

/** The kinds of register offered, by WebAPI type code. */
export const KIND_OF_TYPE = {
  P: 'power',
  V: 'voltage',
  I: 'current',
  F: 'frequency',
  T: 'temperature',
};
export const KINDS = Object.values(KIND_OF_TYPE);

/** A platform id of this integration. */
export const PLATFORM_ID =
  /^(reg-\d{1,7}|virt-[0-9a-f]{16})-(power|voltage|current|frequency|temperature)$/;
export const kindOfPlatform = (platformId) => PLATFORM_ID.exec(platformId)?.[2];

/** The external ids of a device of the meter. */
export const ids = (gladys, platformId) => gladys.externalIds(EXTERNAL_ID_TYPE, platformId);

/** The platform id of a register of the answer, or undefined for a type not offered. */
export function platformIdOf(register) {
  const kind = KIND_OF_TYPE[register.type];
  if (!kind) return undefined;
  const base =
    register.did !== null && register.did !== undefined
      ? `reg-${register.did}`
      : `virt-${createHash('sha256').update(register.name, 'utf8').digest('hex').slice(0, 16)}`;
  return `${base}-${kind}`;
}

/**
 * What a power register accumulates: 'positive' (`+`), 'negative' (`-`),
 * 'absolute' (`|`) or 'net'. The suffixes are those of physical registers
 * (WebAPI glossary); a virtual register is always taken as net.
 */
export function accumulationOf(register) {
  if (register.virtual) return 'net';
  const last = register.name.at(-1);
  if (last === '+') return 'positive';
  if (last === '-') return 'negative';
  if (last === '|') return 'absolute';
  return 'net';
}

/** Namespace of the feature ids of this integration (random, fixed forever). */
const ID_NAMESPACE = Buffer.from('6c0f3d9a1e8b47a2b51e2c7d94f0a3b6', 'hex');

/** A deterministic UUID (version 5, RFC 9562) of a name (as gladys-sunpower-pvs). */
export function uuidOf(name) {
  const hash = createHash('sha1').update(ID_NAMESPACE).update(String(name), 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- The catalog ------------------------------------------------------------------

const measure = (name, category, type, extra = {}) => ({ name, category, type, ...extra });
/** A value shown, never summed nor billed: no energy category, no unit (it is in the name). */
const plain = (name, extra = {}) => measure(name, C.UNKNOWN, T.SENSOR.DECIMAL, extra);

/** Feature keys (forever). */
export const FEATURE = {
  POWER: 'power',
  LIFETIME: 'lifetime',
  CONSUMPTION_POWER: 'consumption_power',
  CONSUMPTION_INDEX: 'consumption_index',
  /** 30-minute consumption: fed by the Gladys core from the index, never by the integration. */
  CONSUMPTION_30MIN: 'consumption_index_30min',
  PRODUCTION_POWER: 'production_power',
  PRODUCTION_INDEX: 'production_index',
  PRODUCTION_30MIN: 'production_index_30min',
  VOLTAGE: 'voltage',
  CURRENT: 'current',
  FREQUENCY: 'frequency',
  TEMPERATURE: 'temperature',
};
const F = FEATURE;

/**
 * An entry: the feature key, what it shows (`power` the rate, `counter` the
 * lifetime value in kWh, `rate` the rate of another kind), its rounding, how
 * it is declared; `role` for the features of a listed register, `limits` for
 * a guarded counter, `declared` for a feature the core feeds, `parent` the
 * index a declared feature hangs on.
 */
const def = (key, value, digits, spec, extra = {}) => ({ key, value, digits, spec, ...extra });
const kwh = { unit: U.KILOWATT_HOUR, max: ENERGY_MAX };

export const CATALOG = {
  power: [
    def(
      F.POWER,
      'power',
      0,
      plain('Power (W, signed as the meter gives it)', {
        min: -POWER_MAX,
        max: POWER_MAX,
      }),
    ),
    def(
      F.LIFETIME,
      'counter',
      3,
      plain('Energy (kWh, lifetime, not counted)', { max: ENERGY_MAX }),
      {
        limits: COUNTER_LIMITS,
        plainCounter: true,
      },
    ),
    def(
      F.CONSUMPTION_POWER,
      'power',
      0,
      measure('Consumption power', C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER, {
        unit: U.WATT,
        min: -POWER_MAX,
        max: POWER_MAX,
      }),
      { role: 'consumption' },
    ),
    def(
      F.CONSUMPTION_INDEX,
      'counter',
      3,
      measure('Consumption index', C.ENERGY_SENSOR, T.ENERGY_SENSOR.INDEX, kwh),
      { role: 'consumption', limits: COUNTER_LIMITS },
    ),
    def(
      F.CONSUMPTION_30MIN,
      undefined,
      3,
      measure(
        'Consumption index (30-minute consumption)',
        C.ENERGY_SENSOR,
        T.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION,
        kwh,
      ),
      { role: 'consumption', declared: true, parent: F.CONSUMPTION_INDEX },
    ),
    def(
      F.PRODUCTION_POWER,
      'power',
      0,
      measure('Production power', C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.POWER, {
        unit: U.WATT,
        max: POWER_MAX,
      }),
      { role: 'production', floor: 0 },
    ),
    def(
      F.PRODUCTION_INDEX,
      'counter',
      3,
      measure(
        'Production index',
        C.ENERGY_PRODUCTION_SENSOR,
        T.ENERGY_PRODUCTION_SENSOR.INDEX,
        kwh,
      ),
      { role: 'production', limits: COUNTER_LIMITS },
    ),
    def(
      F.PRODUCTION_30MIN,
      undefined,
      3,
      measure(
        'Production index (30-minute production)',
        C.ENERGY_PRODUCTION_SENSOR,
        T.ENERGY_PRODUCTION_SENSOR.THIRTY_MINUTES_PRODUCTION,
        kwh,
      ),
      { role: 'production', declared: true, parent: F.PRODUCTION_INDEX },
    ),
  ],
  voltage: [
    def(
      F.VOLTAGE,
      'rate',
      1,
      measure('Voltage', C.ENERGY_SENSOR, T.ENERGY_SENSOR.VOLTAGE, { unit: U.VOLT, max: 100_000 }),
    ),
  ],
  current: [
    def(
      F.CURRENT,
      'rate',
      2,
      measure('Current', C.ENERGY_SENSOR, T.ENERGY_SENSOR.CURRENT, {
        unit: U.AMPERE,
        min: -100_000,
        max: 100_000,
      }),
    ),
  ],
  frequency: [def(F.FREQUENCY, 'rate', 2, plain('Frequency (Hz)', { max: 1000 }))],
  temperature: [
    def(
      F.TEMPERATURE,
      'rate',
      1,
      measure('Temperature', C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, {
        unit: U.CELSIUS,
        min: -100,
        max: 1000,
      }),
    ),
  ],
};

/** The entry of a feature key of a kind. */
export const entryOf = (kind, key) => CATALOG[kind]?.find((e) => e.key === key);

/** Every guarded counter key of the power kind. */
export const COUNTER_KEYS = CATALOG.power.filter((e) => e.limits).map((e) => e.key);

const KNOWN = Object.fromEntries(
  Object.entries(CATALOG).map(([kind, entries]) => [kind, new Set(entries.map((e) => e.key))]),
);

/** The feature keys of a created device (its features are fixed at its creation). */
export function keysOfDevice(kind, device) {
  return new Set(
    (device?.features ?? [])
      .map((f) =>
        String(f.external_id ?? '')
          .split(':')
          .at(-1),
      )
      .filter((key) => KNOWN[kind]?.has(key)),
  );
}

/** Keys read back from /data: known keys of that kind only. */
export const validKeys = (kind, keys) =>
  new Set(Array.isArray(keys) ? keys.filter((key) => KNOWN[kind]?.has(key)) : []);

export const union = (...sets) => new Set(sets.flatMap((s) => [...(s ?? [])]));

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * A BigInt in W·s (or `undefined`) -> kWh (3 decimals, to the Wh), `sign`
 * 1 or -1 applied first. Exact: the division is made on the integer.
 */
export function kwhOf(cumul, sign = 1) {
  if (typeof cumul !== 'bigint') return undefined;
  const wh = (cumul * BigInt(sign)) / 3600n;
  return Number(wh) / 1000;
}

/**
 * The sample of one register: `{ platformId, kind, name, accumulation,
 * role, power, counter, rate }` — values undefined when unknown. `role` is
 * the list of the user that names it ('consumption' | 'production').
 */
export function sampleOf(register, { consumption = [], production = [] } = {}) {
  const platformId = platformIdOf(register);
  if (!platformId) return undefined;
  const kind = KIND_OF_TYPE[register.type];
  const sample = { platformId, kind, name: register.name, virtual: register.virtual };
  if (kind !== 'power') {
    sample.rate = register.rate;
    return sample;
  }
  const accumulation = accumulationOf(register);
  const sign = accumulation === 'negative' ? -1 : 1;
  sample.accumulation = accumulation;
  sample.role = consumption.includes(register.name)
    ? 'consumption'
    : production.includes(register.name)
      ? 'production'
      : undefined;
  sample.power = isNumber(register.rate) ? register.rate * sign : undefined;
  sample.counter = kwhOf(register.cumul, sign);
  return sample;
}

/** Whether an entry applies to a sample (its role, and a plain counter only for a monotonic register). */
function applies(entry, sample) {
  if ((entry.role ?? undefined) !== sample.role) return false;
  if (entry.plainCounter && sample.accumulation === 'net') return false;
  return true;
}

/**
 * The feature keys a sample shows: a value read (a counter above 0). The
 * 30-minute feature comes with its index.
 */
export function capabilitiesOf(sample) {
  const keys = new Set();
  for (const entry of CATALOG[sample.kind] ?? []) {
    if (entry.declared || !applies(entry, sample)) continue;
    const value = sample[entry.value];
    if (isNumber(value) && (!entry.limits || value > 0)) keys.add(entry.key);
  }
  for (const entry of CATALOG[sample.kind] ?? []) {
    if (entry.declared && keys.has(entry.parent)) keys.add(entry.key);
  }
  return keys;
}

/** The name of a device: the register name, bounded (checked by the model). */
const nameOf = (name, kind) => {
  const label = typeof name === 'string' && name !== '' ? name : '?';
  return kind === 'power' ? `eGauge ${label}` : `eGauge ${label} (${kind})`;
};

/**
 * The device of a register. `entry`: `{ platformId, kind, name }`; `keys`:
 * the feature keys to give it (a Set); `params`: `[{ name, value }]`.
 */
export function buildDevice(gladys, entry, keys, params = []) {
  const external = ids(gladys, entry.platformId);
  const features = (CATALOG[entry.kind] ?? [])
    .filter((e) => keys.has(e.key))
    .map(({ key, spec, declared, parent, limits }) => {
      const feature = {
        min: 0,
        read_only: true,
        has_feedback: false,
        keep_history: true,
        ...spec,
        external_id: external.feature(key),
      };
      if (limits && !entryOf(entry.kind, key).plainCounter) {
        feature.id = uuidOf(external.feature(key));
      } else if (declared) {
        feature.id = uuidOf(external.feature(key));
        feature.energy_parent_id = uuidOf(external.feature(parent));
      }
      return feature;
    });
  return {
    name: nameOf(entry.name, entry.kind),
    external_id: external.device,
    features,
    params: params.filter((p) => typeof p.value === 'string' && p.value !== ''),
  };
}

export const round = (value, digits) => {
  const r = Math.round(value * 10 ** digits) / 10 ** digits;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * The states of the plain values of a sample (never a counter, never a
 * 30-minute feature): `[{ device_feature_external_id, state }]`.
 */
export function liveStates(gladys, sample) {
  const external = ids(gladys, sample.platformId);
  const states = [];
  for (const entry of CATALOG[sample.kind] ?? []) {
    if (entry.limits || entry.declared || !applies(entry, sample)) continue;
    let value = sample[entry.value];
    if (!isNumber(value)) continue;
    if (entry.floor !== undefined) value = Math.max(entry.floor, value);
    states.push({
      device_feature_external_id: external.feature(entry.key),
      state: round(value, entry.digits),
    });
  }
  return states;
}

/** The counters a sample feeds: `[entry]` (its role decides which). */
export const countersOf = (sample) =>
  (CATALOG[sample.kind] ?? []).filter((e) => e.limits && applies(e, sample));

/** The state of a lifetime counter: never 0 (nor below), whatever the meter said. */
export const counterState = (gladys, platformId, key, value) =>
  isNumber(value) && value > 0
    ? [{ device_feature_external_id: ids(gladys, platformId).feature(key), state: round(value, 3) }]
    : [];
