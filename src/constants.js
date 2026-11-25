// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (actions,
// manifest keys, feature keys in src/devices.js, external ids) is forever:
// never rename one.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const ACTIONS = {
  TEST: 'test_connection',
  TRUST_CERTIFICATE: 'trust_certificate',
  ACCEPT_HELD: 'accept_held',
};

/** The type part of every external id: `ext:<selector>:egauge:<platform id>`. */
export const EXTERNAL_ID_TYPE = 'egauge';

// --- The eGauge WebAPI (webapi.egauge.net, egauge-python) -------------------------

/** HTTPS on the LAN (a self-signed certificate: confirmed by the user, src/app.js checkPeer). */
export const DEFAULT_PORT = 443;
/** The version of package.json (the Release workflow bumps it): the User-Agent follows. */
function packageVersion() {
  try {
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    return /^\d+\.\d+\.\d+$/.test(version) ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
export const USER_AGENT = `gladys-egauge/${packageVersion()} (+https://github.com/LM1LC3N7/gladys-egauge)`;

/**
 * The ONLY paths this integration ever asks, all of them reads but the login.
 * `/api/cmd` (reboot, clear, factory restore...) and `/api/config` are never
 * called: no path is built from anything else (test/client.test.js).
 */
export const PATHS = {
  /** 401 with the realm and the server nonce of the digest login. */
  UNAUTHORIZED: '/api/auth/unauthorized',
  /** POST { rlm, usr, nnc, cnnc, hash } -> { jwt }: the password never leaves Gladys. */
  LOGIN: '/api/auth/login',
  /** The serial number of the meter: its identity, checked at every read. */
  SERIAL: '/api/sys/sn',
  /**
   * The latest row of every register: `raw` (lifetime values counted from the
   * creation of the database, never moved by a new "epoch" set in the meter),
   * `rate` (the current values), virtual registers computed by the meter.
   */
  REGISTERS: '/api/register?raw&rate&virtual=value&time=now',
};

/** A JWT is "typically valid for about 10 minutes": a new one after 8. */
export const TOKEN_MAX_AGE = 8 * 60 * 1000;

// --- Sizes and times of a request ---------------------------------------------------------

/** One request: 15 s for the whole exchange, body included. */
export const REQUEST_TIMEOUT = 15_000;
/** The login, the nonce, the serial number: a few hundred bytes. */
export const SMALL_BYTES = 16 * 1024;
/** The registers: about 100 bytes each, a few hundred at most. */
export const REGISTER_BYTES = 1024 * 1024;
/** Registers in one answer, at most (an EG4030 has 64 physical ones, plus virtual ones). */
export const MAX_REGISTERS = 1000;
/** A register name: bounded (the meter limits it far below). */
export const MAX_NAME = 120;

// --- Schedule ------------------------------------------------------------------------
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** One read every 30 s, never faster, whatever asks for it. */
export const POLL_INTERVAL = 30 * SECOND;
/** The lifetime counters: once a minute at most. */
export const INDEX_INTERVAL = MINUTE;
/** An unreachable meter or a wrong answer: tries after 30 s, doubled up to 5 minutes (a LAN device). */
export const RETRY_MIN = 30 * SECOND;
export const RETRY_MAX = 5 * MINUTE;
/** HTTP 429 or 5xx: a pause from 1 min to 6 h, kept in /data. */
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** The test button answers within this delay (the manifest gives it 30 s). */
export const TEST_ANSWER_WITHIN = 25 * SECOND;
/** `getConfig()` failing at a connection: tried again after 5 s, doubled up to 5 min, without end. */
export const CONFIG_RETRY_MIN = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;
/** A row older than this (against the clock of the meter) is never published. */
export const STALE_AFTER = 2 * HOUR;
/** A row older than this is published with its own date. */
export const DATED_AFTER = 10 * MINUTE;
/** The two-click buttons: the second click comes 3 s to 5 min after the first. */
export const CONFIRM_AFTER = 3 * SECOND;
export const CONFIRM_WITHIN = 5 * MINUTE;
/** A TLS handshake made by "Trust the certificate" (nothing is written on it). */
export const PROBE_TIMEOUT = 10 * SECOND;
/** A stop saves /data, then waits for the read running at most this long and saves again. */
export const STOP_WAIT = 5 * SECOND;
/** Gladys takes 300 states a minute from an integration: this one sends 250 at most. */
export const STATES_PER_MINUTE = 250;

// --- Bounds of the values --------------------------------------------------------------
/** A power, in W: beyond is not a reading. */
export const POWER_MAX = 10_000_000;
/** A lifetime counter, in kWh. */
export const ENERGY_MAX = 10_000_000_000;

/**
 * Plausibility of a lifetime counter (src/guard.js): 1000 kW on average at
 * most (an eGauge may measure a whole building), 0.5 kWh of slack.
 */
export const COUNTER_LIMITS = { maxKw: 1000, slackKwh: 0.5 };
/**
 * A NET register (no `+`, `-` nor `|` at the end of its name) counted as
 * consumption or production may go down a little (the standby draw of an
 * inverter at night, a few Wh): a value at most this far below the last one
 * published is neither published nor held, the last value stays. A larger
 * drop goes to the guard (held until the user accepts it).
 */
export const NET_DROP_SLACK_KWH = 0.2;
