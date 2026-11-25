// -----------------------------------------------------------------------------
// The integration itself: one eGauge meter read through its WebAPI (HTTPS on
// the LAN, a self-signed certificate confirmed by the user), one Gladys device
// per register of a supported type, every lifetime counter through its guard.
// index.js only wires the SDK handlers to it. Read-only: the meter is never
// commanded nor configured (`/api/cmd` and `/api/config` are never called).
//
// One read = the serial number of the meter (its identity) and the latest row
// of its registers, on a JWT obtained by the digest login (the password never
// leaves Gladys).
//
// The certificate: nothing is sent to the meter before the user confirmed the
// fingerprint of its certificate, typed in the form or trusted with the
// "Trust the certificate" button (two clicks, each a TLS handshake only). The
// fingerprint met is shown in the status. A certificate that changes later
// is never learned again by itself: nothing is sent until the user confirms
// the new one the same way.
//
// The pace is global and kept across restarts: never two reads less than an
// interval apart, whatever asks (a reconnection, a save of the form, the test
// button, the Discover tab, a device created, a restart of the container: the
// time of the last read is kept in /data before the request).
//
// A read belongs to its session (the client of one address, account and
// typed fingerprint): when they change, a late answer of the old one
// publishes nothing and sets no status (checked after every await).
//
// Identity: every read asks the serial number of the meter; /data keeps a
// salted hash of it (never the number). Another meter at the address: no
// value published until the user accepts it ("Accept the held values", two
// clicks); a serial number that cannot be read: no value published from that
// read.
//
// Freshness: a row is published once (its time in /data), and never when it
// is more than 2 h older than the clock of the meter (its Date header); with
// no readable clock it is never "expired".
//
// /data: a file that exists but cannot be read is not an empty state: it is
// never overwritten, no certificate is trusted by the button (a typed
// fingerprint still works), no counter is published until it reads. A save
// that fails holds the counters back too.
//
// Clocks: `monotonic` paces the reads, the pauses, the retries and the token.
// The guards of the counters run on the SESSION clock: the wall clock read
// once at the start of the process plus the monotonic time since
// (`sessionNow`), so that NTP moving the wall clock never widens nor narrows
// their margin (as gladys-sunpower-pvs, approved). The wall clock itself only
// dates what /data keeps for a restart. Each decision reads each clock once.
// -----------------------------------------------------------------------------

import { createHmac, randomBytes } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { addressOf, isComplete, normalizeConfig, targetKey } from './config.js';
import {
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  CONFIRM_AFTER,
  CONFIRM_WITHIN,
  DATED_AFTER,
  INDEX_INTERVAL,
  NET_DROP_SLACK_KWH,
  PAUSE_MAX,
  PAUSE_MIN,
  POLL_INTERVAL,
  PROBE_TIMEOUT,
  RETRY_MAX,
  RETRY_MIN,
  STALE_AFTER,
  STATES_PER_MINUTE,
  STOP_WAIT,
  TEST_ANSWER_WITHIN,
} from './constants.js';
import {
  PLATFORM_ID,
  buildDevice,
  capabilitiesOf,
  counterState,
  countersOf,
  entryOf,
  ids,
  keysOfDevice,
  kindOfPlatform,
  liveStates,
  sampleOf,
  union,
  validKeys,
} from './devices.js';
import { EgaugeClient } from './egauge/client.js';
import { CODES, EgaugeError, isCertificate } from './egauge/errors.js';
import { probeCertificate } from './egauge/http.js';
import { validName } from './egauge/model.js';
import { IndexGuard } from './guard.js';
import { T } from './i18n.js';
import { createFileStore } from './store.js';

const defaultTimers = { setTimeout, clearTimeout };

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hmac = (salt, value) => createHmac('sha256', salt).update(value, 'utf8').digest('hex');
const FP = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/**
 * The tag of a refused login: 8 bits of a salted hash of the user name and
 * the password, never more (a short password must not be found back from
 * /data by brute force). Two logins share it once in 256: the test button
 * then tries anyway.
 */
export const tagOf = (salt, username, password) =>
  createHmac('sha256', salt).update(`${username}\u0000${password}`).digest()[0];

/** The index Gladys already holds for a feature of a created device (wall date), when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    value > 0 &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/** What ties a kept counter state to ONE Gladys device: its id (a device created again is another). */
const deviceKeyOf = (device) =>
  typeof device?.id === 'string' && device.id !== ''
    ? device.id
    : typeof device?.created_at === 'string'
      ? device.created_at
      : undefined;

/** /data read back, every field checked; anything odd is dropped, never trusted. */
export function readMemory(data) {
  const m = isPlain(data) ? data : {};
  const out = {
    salt: typeof m.salt === 'string' && /^[0-9a-f]{32}$/.test(m.salt) ? m.salt : undefined,
    pins: {},
    certSeen: undefined,
    identity:
      typeof m.identity === 'string' && /^[0-9a-f]{64}$/.test(m.identity) ? m.identity : undefined,
    pause: undefined,
    refused: undefined,
    lastAttemptAt: finite(m.lastAttemptAt) ? m.lastAttemptAt : undefined,
    seen: {},
    counters: {},
    samples: {},
  };
  for (const [key, fp] of Object.entries(isPlain(m.pins) ? m.pins : {})) {
    if (key.length <= 300 && typeof fp === 'string' && FP.test(fp)) out.pins[key] = fp;
  }
  const c = m.certSeen;
  if (isPlain(c) && typeof c.key === 'string' && typeof c.seen === 'string' && FP.test(c.seen)) {
    out.certSeen = { key: c.key, seen: c.seen };
  }
  const p = m.pause;
  if (
    isPlain(p) &&
    typeof p.key === 'string' &&
    finite(p.until) &&
    Number.isInteger(p.count) &&
    p.count >= 1 &&
    (p.code === CODES.RATE_LIMITED || p.code === CODES.SERVER)
  ) {
    out.pause = {
      key: p.key,
      until: p.until,
      count: Math.min(p.count, 32),
      code: p.code,
      status: Number.isInteger(p.status) ? p.status : null,
    };
  }
  const r = m.refused;
  if (
    isPlain(r) &&
    typeof r.key === 'string' &&
    Number.isInteger(r.tag) &&
    r.tag >= 0 &&
    r.tag < 256
  ) {
    out.refused = { key: r.key, tag: r.tag };
  }
  for (const [platformId, entry] of Object.entries(isPlain(m.seen) ? m.seen : {})) {
    if (!PLATFORM_ID.test(platformId) || !isPlain(entry)) continue;
    const kind = kindOfPlatform(platformId);
    out.seen[platformId] = {
      kind,
      keys: [...validKeys(kind, entry.keys)],
      ...(validName(entry.name) ? { name: entry.name } : {}),
    };
  }
  for (const [id, entry] of Object.entries(isPlain(m.counters) ? m.counters : {})) {
    const [platformId, key, ...rest] = id.split('|');
    if (rest.length > 0 || !PLATFORM_ID.test(platformId ?? '') || !isPlain(entry)) continue;
    if (!entryOf(kindOfPlatform(platformId), key)?.limits) continue;
    out.counters[id] = {
      ...(typeof entry.device === 'string' && entry.device.length <= 100
        ? { device: entry.device }
        : {}),
      last: isPlain(entry.last) ? entry.last : null,
      held: isPlain(entry.held) ? entry.held : null,
    };
  }
  for (const [platformId, at] of Object.entries(isPlain(m.samples) ? m.samples : {})) {
    if (PLATFORM_ID.test(platformId) && finite(at)) out.samples[platformId] = at;
  }
  return out;
}

export class EgaugeApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'egauge' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    request,
    probe = probeCertificate,
    store = createFileStore(),
    random = () => randomBytes(16).toString('hex'),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    /** The transport of the client (tests inject a fake meter); undefined: node:https. */
    this.request = request;
    /** The TLS handshake of "Trust the certificate" (tests inject one). */
    this.probe = probe;
    this.random = random;
    this.store = store;
    /** The session clock: wall at the start of the process + monotonic elapsed since. */
    this.wallStart = now();
    this.monoStart = monotonic();
    this.config = normalizeConfig();
    /** `{ client, key }` of the current address, account and fingerprint. */
    this.session = undefined;
    this.running = false;
    this.timer = undefined;
    this.busy = undefined;
    this.loopRun = Promise.resolve();
    this.lifecycle = Promise.resolve();
    this.lastStatus = undefined;
    this.savedKey = undefined;
    this.saveFailed = false;
    /** The first click of "Accept the held values": `{ at, listedAt, list, other, session }`. */
    this.pendingAccept = undefined;
    /** The first click of "Trust the certificate": `{ at, fingerprint, session }`. */
    this.pendingTrust = undefined;
    /** The connection to Gladys: a new one (or a save) ends the getConfig retries of the old. */
    this.connection = 0;
    this.configTimer = undefined;
    this.configFailures = 0;
    this.configRun = Promise.resolve();
    /** By `<platform id>|<key>`: `{ guard, device }`. */
    this.guards = new Map();
    /** By `<platform id>|<key>`: the hold already logged (one line per hold). */
    this.heldLogged = new Map();
    /** The states sent in the last minute: `[{ at, count }]` on the monotonic clock. */
    this.sent = [];
    /** Platform ids whose counters are sent again from their current sample (an acceptance). */
    this.recount = new Set();
    /** /data could not be read: `{ code }`; nothing written, no counter published. */
    this.storeError = undefined;
    this.loadState();
    this.resetReads();
  }

  /** The session clock (ms since epoch): never moved by a wall clock set by NTP. */
  sessionNow() {
    return this.wallStart + (this.monotonic() - this.monoStart);
  }

  /** Reads /data; an unreadable file is kept as an error, never taken for an empty state. */
  loadState() {
    const result = this.store.load();
    if (!result?.ok) {
      if (!this.storeError) {
        this.logger.warn(
          `egauge: /data cannot be read (${result?.code ?? 'error'}): counters held`,
        );
      }
      this.storeError = { code: result?.code ?? 'error' };
      this.memory ??= readMemory({});
      this.memory.salt ??= this.random();
      return false;
    }
    const kept = readMemory(result.data);
    kept.salt ??= this.random();
    const at = this.now();
    const mono = this.monotonic();
    this.storeError = undefined;
    this.memory = kept;
    this.guards.clear();
    // The last read before a restart: the next one never comes sooner than
    // the interval (a date in the future, a clock set back, is brought to now).
    if (kept.lastAttemptAt !== undefined && this.lastAttemptAt === undefined) {
      this.lastAttemptAt = Math.min(kept.lastAttemptAt, at);
      this.lastReadAt = mono - (at - this.lastAttemptAt);
    }
    this.savedKey = undefined;
    return true;
  }

  /** What belongs to one session: forgotten when it changes. */
  resetReads() {
    /** The last read: `{ at (monotonic), kind: 'reading' | 'error', ... }`. */
    this.outcome = undefined;
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    /** Monotonic time the counters were last published. */
    this.lastIndexAt = undefined;
    /** The latest identity check: 'ok' | 'other' | 'unreadable' | undefined. */
    this.identityState = undefined;
    this.otherIdentity = undefined;
  }

  // --- Connection to Gladys -------------------------------------------------------

  /**
   * A (re)connection to Gladys: its configuration, then a start. A
   * `getConfig()` that fails is tried again without end (5 s doubled up to
   * 5 min), the status saying so, until it answers or the connection ends.
   */
  connected(getConfig) {
    const token = ++this.connection;
    this.configFailures = 0;
    this.clearConfigTimer();
    this.configRun = this.tryConfig(getConfig, token);
    return this.configRun;
  }

  /** The connection to Gladys is lost: the retries of getConfig end, the reads stop. */
  disconnected() {
    this.connection += 1;
    this.clearConfigTimer();
    return this.stop();
  }

  /** The user saved the form: this configuration wins over a getConfig still being tried. */
  configUpdated(raw) {
    this.connection += 1;
    this.clearConfigTimer();
    return this.start(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  async tryConfig(getConfig, token) {
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (token !== this.connection) return;
      const wait = Math.min(CONFIG_RETRY_MIN * 2 ** this.configFailures, CONFIG_RETRY_MAX);
      this.configFailures = Math.min(this.configFailures + 1, 16);
      this.logger.warn(`egauge: the configuration could not be read (${err?.name ?? 'Error'})`);
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(wait));
      if (token !== this.connection) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.configRun = this.tryConfig(getConfig, token);
        return this.configRun;
      }, wait);
      return;
    }
    if (token !== this.connection) return;
    this.configFailures = 0;
    await this.start(raw);
  }

  // --- Lifecycle -------------------------------------------------------------

  start(raw = {}) {
    return this.serialize(() => this.doStart(raw));
  }

  /**
   * Stops the reads, waits (bounded) for the one running, and writes /data:
   * the time of the last read and what was seen since the last save are
   * never lost by a clean stop.
   */
  stop() {
    return this.serialize(async () => {
      this.doStop();
      // Written first: Docker stops the container 10 s after asking.
      await this.saveState();
      if (this.busy) {
        let timer;
        await Promise.race([
          this.busy.catch(() => {}),
          new Promise((resolve) => {
            timer = this.timers.setTimeout(resolve, STOP_WAIT);
          }),
        ]);
        this.timers.clearTimeout(timer);
      }
      await this.saveState();
    });
  }

  /** Resolves once every queued start/stop and the read running are done (tests). */
  async idle() {
    await this.configRun;
    await this.lifecycle;
    await this.loopRun;
    await this.busy;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /** The key of what a session is: the address, the account, the typed fingerprint. */
  static sessionKey(config) {
    return JSON.stringify([
      config.host,
      config.hostError,
      config.port,
      config.username,
      config.usernameInvalid,
      config.password,
      config.passwordInvalid,
      config.fingerprint,
    ]);
  }

  async doStart(raw) {
    this.doStop();
    const config = normalizeConfig(raw);
    const first = this.session === undefined;
    const changed = first || EgaugeApp.sessionKey(config) !== EgaugeApp.sessionKey(this.config);
    this.config = config;
    if (changed) {
      this.session?.client?.close();
      const session = { key: targetKey(config) };
      session.client = isComplete(config)
        ? new EgaugeClient({
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            monotonic: this.monotonic,
            checkPeer: (fingerprint) => this.checkPeer(session, fingerprint),
            ...(this.request ? { request: this.request } : {}),
          })
        : undefined;
      session.discovered = false;
      this.session = session;
      // A list of a first click belongs to its session.
      this.pendingAccept = undefined;
      this.pendingTrust = undefined;
      if (!first) this.resetReads();
    }
    await this.applyMemory();
    this.running = true;
    // The core keeps the connection status, the Discovery list and the last
    // values in memory: a restarted Gladys has lost them, so they are always
    // sent again (the values at the next row, never a value of before).
    this.lastStatus = undefined;
    this.lastIndexAt = undefined;
    this.lastBadges = undefined;
    this.gladys.forgetPublishedStates?.();
    if (!this.session.client) {
      await this.updateStatus();
      return;
    }
    await this.discover();
    await this.updateStatus();
    this.schedule();
  }

  /** The refusal, the pause and the certificate met kept in /data, against this configuration. */
  async applyMemory() {
    const m = this.memory;
    const key = this.session.key;
    let dirty = false;
    // A login refused stands only for the same address, user name and password.
    if (m.refused && !this.refusedApplies()) {
      m.refused = undefined;
      dirty = true;
    }
    // A pause asked by another address ends; the pace does not.
    if (m.pause && m.pause.key !== key) {
      m.pause = undefined;
      dirty = true;
    }
    if (m.certSeen && (m.certSeen.key !== key || this.config.fingerprint)) {
      // Another address, or a fingerprint typed: it is the authority now
      // (checkPeer imposes it; another certificate is refused, showing the
      // one met, nothing sent).
      m.certSeen = undefined;
      dirty = true;
    }
    if (dirty) await this.saveState();
  }

  doStop() {
    this.running = false;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Whether the login refused by the meter is the one configured now. */
  refusedApplies() {
    const r = this.memory.refused;
    const config = this.config;
    return Boolean(
      r &&
      this.session &&
      r.key === this.session.key &&
      r.tag === tagOf(this.memory.salt, config.username, config.password),
    );
  }

  // --- The certificate ---------------------------------------------------------

  /** The fingerprint trusted for this session: the one typed, else the one confirmed in /data. */
  trusted() {
    return this.config.fingerprint || this.memory.pins[this.session?.key] || undefined;
  }

  /**
   * Right after the TLS handshake, before any byte is written: the
   * certificate of the meter must be the fingerprint typed, else the one the
   * user confirmed (kept in /data). With neither, nothing is sent: the
   * fingerprint met goes to the status, for the user to confirm.
   */
  async checkPeer(session, fingerprint) {
    if (session !== this.session || !this.running) {
      throw new EgaugeError(CODES.LATE, 'Configuration changed');
    }
    const m = this.memory;
    const key = session.key;
    const typed = this.config.fingerprint;
    if (typed) {
      if (fingerprint !== typed) {
        throw new EgaugeError(CODES.CERTIFICATE_TYPED, 'Not the certificate typed', {
          fingerprint,
        });
      }
      if (m.pins[key] !== typed && !this.storeError) {
        m.pins = { [key]: typed };
        // Kept when /data allows it; the typed value is the reference anyway.
        await this.saveState();
        if (session !== this.session || !this.running) {
          throw new EgaugeError(CODES.LATE, 'Configuration changed');
        }
      }
      return;
    }
    const pin = m.pins[key];
    if (!pin) {
      throw new EgaugeError(CODES.CERTIFICATE_UNCONFIRMED, 'Certificate not confirmed yet', {
        fingerprint,
      });
    }
    if (fingerprint !== pin) {
      throw new EgaugeError(CODES.CERTIFICATE, 'Another certificate', { fingerprint });
    }
  }

  /**
   * "Trust the certificate", in two clicks: the first makes a TLS handshake
   * (nothing written on it) and shows the fingerprint met; the second, 3 s to
   * 5 min later, makes another one and trusts that certificate only when it
   * is the same fingerprint. Never with a fingerprint typed (it is the
   * authority), never with a /data that cannot keep it.
   */
  async trustCertificate() {
    const session = this.session;
    if (!session?.client) return this.currentStatus()[1];
    if (this.config.fingerprint) return T.trust.typed;
    if (this.storeError) return T.trust.storeUnreadable;
    const mono = this.monotonic();
    const pending = this.pendingTrust;
    this.pendingTrust = undefined;
    let fingerprint;
    try {
      fingerprint = await this.probe(this.session.client.target, { timeout: PROBE_TIMEOUT });
    } catch (err) {
      return T.trust.failed(addressOf(this.config), err);
    }
    if (session !== this.session) return T.trust.changed;
    if (!FP.test(fingerprint ?? '')) return T.trust.failed(addressOf(this.config), {});
    const key = session.key;
    if (this.memory.pins[key] === fingerprint) return T.trust.already(fingerprint);
    const elapsed = pending ? mono - pending.at : undefined;
    if (
      !pending ||
      pending.session !== session ||
      elapsed > CONFIRM_WITHIN ||
      elapsed < CONFIRM_AFTER
    ) {
      this.pendingTrust = { at: mono, fingerprint, session };
      return T.trust.confirm(addressOf(this.config), fingerprint, CONFIRM_WITHIN);
    }
    if (pending.fingerprint !== fingerprint) return T.trust.different(fingerprint);
    const before = this.memory.pins;
    const beforeSeen = this.memory.certSeen;
    this.memory.pins = { [key]: fingerprint };
    this.memory.certSeen = undefined;
    if (!(await this.saveState())) {
      this.memory.pins = before;
      this.memory.certSeen = beforeSeen;
      return T.trust.unwritable;
    }
    this.logger.info('egauge: the certificate of the meter is trusted by the user');
    // A read at its time (never sooner than the interval): the failures were
    // the certificate's, not the meter's.
    session.client.close();
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    await this.updateStatus();
    if (this.running) this.schedule();
    return T.trust.done(fingerprint);
  }

  // --- Pace ------------------------------------------------------------------

  /** The rest of the pause (ms), from its wall end, capped to PAUSE_MAX at every use; 0 when none. */
  pauseLeft(mono) {
    const p = this.memory.pause;
    if (!p || !this.session || p.key !== this.session.key) return 0;
    if (p.due === undefined) {
      // Read back from /data: its rest, onto the monotonic clock, once.
      p.due = mono + Math.min(Math.max(0, p.until - this.now()), PAUSE_MAX);
    }
    return Math.min(Math.max(0, p.due - mono), PAUSE_MAX);
  }

  /** The monotonic time from which the next read may start, from the caller's instant `mono`. */
  dueAt(mono) {
    let due = this.lastReadAt === undefined ? mono : this.lastReadAt + POLL_INTERVAL;
    if (this.nextTryAt !== undefined) due = Math.max(due, this.nextTryAt);
    return Math.max(due, mono + this.pauseLeft(mono));
  }

  /** One timer: the next read when it is due; none while the login is refused. */
  schedule() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.running || !this.session?.client || this.refusedApplies()) return;
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.loopRun = this.loop();
      return this.loopRun;
    }, wait);
  }

  async loop() {
    const session = this.session;
    try {
      await this.tick();
    } catch (err) {
      this.logger.error(`egauge: unexpected error (${err?.name ?? 'Error'})`);
    }
    if (session === this.session && this.running) this.schedule();
  }

  /** One read when it is due; a read running is never doubled. */
  tick({ evenRefused = false } = {}) {
    if (this.busy) return this.busy;
    this.busy = this.read({ evenRefused }).finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  async read({ evenRefused }) {
    const session = this.session;
    if (!session?.client || !this.running) return;
    // A refused login is never tried again by itself: only the test button.
    if (!evenRefused && this.refusedApplies()) return;
    const mono = this.monotonic();
    // A timer a little early (rounded to the ms): the next one comes when due.
    if (mono < this.dueAt(mono)) return;
    await this.poll(session, mono);
  }

  /** The read itself, once it is due (`mono`: the instant of that decision). */
  async poll(session, mono) {
    /** Another session (or a stop) during an await: this read gives up, silently. */
    const gone = () => session !== this.session || !this.running;
    const client = session.client;
    // Tried again at each read: once /data reads, the counters go on.
    if (this.storeError) this.loadState();
    this.lastReadAt = mono;
    // Kept BEFORE the request: a restart during it never reads again sooner.
    this.lastAttemptAt = this.now();
    await this.saveState();
    if (gone()) return;
    let serial;
    let answer;
    try {
      serial = await client.readSerial();
      if (gone()) return;
      answer = await client.readRegisters();
    } catch (err) {
      if (gone()) return;
      await this.failed(err, gone);
      return;
    }
    if (gone()) return;
    await this.succeeded(serial, answer, mono, gone);
    if (gone()) return;
    await this.afterRead(mono, gone);
  }

  // --- Outcomes ----------------------------------------------------------------

  async succeeded(serial, answer, mono, gone) {
    // An answer: a pause asked before, the retries, a refused login and a
    // certificate met are over.
    const m = this.memory;
    const wasRefused = Boolean(m.refused);
    m.pause = undefined;
    m.refused = undefined;
    m.certSeen = undefined;
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    if (wasRefused) this.logger.info('egauge: the meter accepts the login again');
    const lists = { consumption: this.config.consumption, production: this.config.production };
    const samples = [];
    let unsupported = 0;
    for (const register of answer.registers) {
      const sample = sampleOf(register, lists);
      if (sample) samples.push(sample);
      else unsupported += 1;
    }
    const names = new Set(answer.registers.map((r) => r.name));
    const missing = [...this.config.consumption, ...this.config.production].filter(
      (n) => !names.has(n),
    );
    this.outcome = {
      at: mono,
      kind: 'reading',
      rowAt: answer.at,
      date: answer.date,
      samples,
      unsupported: unsupported + answer.skipped,
      missing,
    };
    await this.checkIdentity(serial);
    if (gone()) return;
    await this.saveState();
  }

  /**
   * The serial number of this read against the identity in /data (a salted
   * hash): learned at the first read (saved before any value), the same: ok;
   * another: nothing published until the user accepts it; unreadable: nothing
   * published from this read (never "another meter").
   */
  async checkIdentity(serial) {
    const m = this.memory;
    if (!serial || this.storeError) {
      // /data cannot tell which meter it was, or the meter did not say.
      this.identityState = 'unreadable';
      return;
    }
    const seen = hmac(m.salt, serial);
    if (!m.identity) {
      m.identity = seen;
      this.identityState = (await this.saveState()) ? 'ok' : 'unreadable';
      if (this.identityState !== 'ok') m.identity = undefined;
      return;
    }
    if (m.identity === seen) {
      this.identityState = 'ok';
      this.otherIdentity = undefined;
      return;
    }
    if (this.otherIdentity !== seen) {
      this.logger.warn('egauge: another meter answers at the address: nothing published');
    }
    this.identityState = 'other';
    this.otherIdentity = seen;
  }

  /** After a read: Discovery when something new showed, the values, /data, the status. */
  async afterRead(mono, gone) {
    if (this.outcome?.kind === 'reading' && this.identityState === 'ok') {
      if (this.learn() || !this.session.discovered) {
        this.session.discovered = true;
        await this.discover();
        if (gone()) return;
      }
      await this.publish(mono, gone);
      if (gone()) return;
    }
    await this.saveState();
    if (gone()) return;
    await this.updateStatus();
  }

  /** The current samples, the device published longest ago first (the budget goes round). */
  currentSamples() {
    if (this.outcome?.kind !== 'reading') return [];
    const last = (s) => this.memory.samples[s.platformId] ?? 0;
    return [...this.outcome.samples].sort((a, b) => last(a) - last(b));
  }

  /** The feature keys seen, from the samples of this read; whether a key or a name is new. */
  learn() {
    const seen = this.memory.seen;
    let grew = false;
    for (const sample of this.currentSamples()) {
      const keys = capabilitiesOf(sample);
      if (keys.size === 0) continue;
      const before = seen[sample.platformId];
      const all = union(before?.keys, keys);
      if (!before || all.size !== before.keys.length || before.name !== sample.name) grew = true;
      seen[sample.platformId] = { kind: sample.kind, keys: [...all], name: sample.name };
    }
    return grew;
  }

  async failed(err, gone) {
    const code = err?.code ?? 'error';
    // The pause and the next try count from the failure, not from the start of the read.
    const at = this.monotonic();
    const now = this.now();
    const m = this.memory;
    // Our own words only (EgaugeError codes): never a text of the meter.
    this.logger.warn(
      `egauge read failed: ${code}${Number.isInteger(err?.status) ? ` ${err.status}` : ''}`,
    );
    this.outcome = { at, kind: 'error', err };
    if (code === CODES.CREDENTIALS) {
      // The login is refused: final, kept in /data, never tried again by
      // itself (only another user name or password, or the test button).
      m.refused = {
        key: this.session.key,
        tag: tagOf(m.salt, this.config.username, this.config.password),
      };
      this.failures = 0;
      this.nextTryAt = undefined;
      this.lastError = undefined;
      await this.saveState();
      if (gone()) return;
      await this.updateStatus();
      return;
    }
    if (code === CODES.RATE_LIMITED || code === CODES.SERVER) {
      const count = (m.pause?.count ?? 0) + 1;
      const asked = finite(err.retryAfter) ? err.retryAfter : PAUSE_MIN * 2 ** (count - 1);
      const wait = Math.min(Math.max(asked, PAUSE_MIN), PAUSE_MAX);
      m.pause = {
        key: this.session.key,
        until: now + wait,
        due: at + wait,
        count: Math.min(count, 32),
        code,
        status: Number.isInteger(err.status) ? err.status : null,
      };
      await this.saveState();
      if (gone()) return;
      await this.updateStatus();
      return;
    }
    if (isCertificate(err) && typeof err.fingerprint === 'string' && FP.test(err.fingerprint)) {
      if (m.certSeen?.seen !== err.fingerprint) {
        this.logger.warn(
          code === CODES.CERTIFICATE_UNCONFIRMED
            ? 'egauge: the certificate of the meter is not confirmed yet: nothing sent'
            : 'egauge: the certificate of the meter is not the trusted one: nothing sent',
        );
      }
      m.certSeen = { key: this.session.key, seen: err.fingerprint };
    }
    // Retries doubled (never faster than the interval).
    const wait = Math.min(RETRY_MIN * 2 ** this.failures, RETRY_MAX);
    this.failures = Math.min(this.failures + 1, 16);
    this.lastError = err;
    this.nextTryAt = at + wait;
    await this.saveState();
    if (gone()) return;
    await this.updateStatus();
  }

  // --- Values ------------------------------------------------------------------------

  /** The created Gladys device of a platform id, undefined until the user creates it. */
  createdDevice(platformId) {
    const id = ids(this.gladys, platformId).device;
    return (this.gladys.devices ?? []).find((d) => d.external_id === id);
  }

  /** The guard of a counter of a created device, from Gladys and /data (session clock). */
  guardOf(platformId, key, created, limits) {
    const id = `${platformId}|${key}`;
    const device = deviceKeyOf(created);
    const current = this.guards.get(id);
    if (current && current.device !== device) {
      // Another device of this platform id (created again while the app was away).
      this.forgetCounter(id);
    }
    if (!this.guards.has(id)) {
      let saved = this.memory.counters[id];
      if (saved?.device !== undefined && device !== undefined && saved.device !== device) {
        // Kept for another device (deleted, created again): never its reference.
        delete this.memory.counters[id];
        saved = undefined;
      }
      const sessionNow = this.sessionNow();
      // /data and Gladys hold wall dates: back to the session clock; a date
      // "in the future" (a wall clock set back) is now, so that the margin of
      // the next rise never shrinks to nothing.
      const offset = this.now() - sessionNow;
      const toSession = (ref) =>
        isPlain(ref) && finite(ref.at)
          ? { ...ref, at: Math.min(ref.at - offset, sessionNow) }
          : undefined;
      const kept = saved ? { last: toSession(saved.last), held: toSession(saved.held) } : undefined;
      const known = toSession(lastValueOf(created, ids(this.gladys, platformId).feature(key)));
      this.guards.set(id, { guard: new IndexGuard(known, kept, sessionNow, limits), device });
    }
    return this.guards.get(id).guard;
  }

  forgetCounter(id) {
    this.guards.delete(id);
    this.heldLogged.delete(id);
    delete this.memory.counters[id];
  }

  /** One log line per hold (its direction), never one per read; never a value. */
  logHold(id, guard) {
    const held = guard.held;
    const key = held ? `${held.direction}:${held.from}` : undefined;
    if (key && this.heldLogged.get(id) !== key) {
      this.logger.warn(
        `egauge: a lifetime counter ${held.direction === 'down' ? 'drop' : 'jump'} held back (${id})`,
      );
    }
    if (key) this.heldLogged.set(id, key);
    else this.heldLogged.delete(id);
  }

  /** States still allowed this minute (STATES_PER_MINUTE), on the monotonic clock. */
  budget(mono) {
    // A minute and a margin: Gladys counts on its own clock.
    this.sent = this.sent.filter((s) => mono - s.at < 65_000 && s.at <= mono);
    return STATES_PER_MINUTE - this.sent.reduce((sum, s) => sum + s.count, 0);
  }

  /** Whether the row of this read may be published against the clock of the meter. */
  fresh() {
    const at = this.outcome?.rowAt;
    const clock = this.outcome?.date;
    if (at === undefined || clock === undefined) return true;
    return Math.abs(clock - at) <= STALE_AFTER;
  }

  /**
   * Whether a counter value is a small drop of a NET register (the standby
   * draw of an inverter at night): neither published nor held, the last
   * value stays (src/constants.js NET_DROP_SLACK_KWH).
   */
  static smallNetDrop(sample, guard, value) {
    const last = guard.last?.value;
    return (
      sample.accumulation === 'net' &&
      !guard.accepted &&
      finite(last) &&
      value < last &&
      last - value <= NET_DROP_SLACK_KWH
    );
  }

  /**
   * The states of the current row for the created devices: each row once
   * (its time kept in /data), never stale; the counters once a minute. The
   * guards are in /data BEFORE Gladys gets a counter: a save that fails (or a
   * /data unreadable) sends none. Within the budget of states: a device left
   * out is sent at the next read.
   */
  async publish(mono, gone) {
    if (this.lastIndexAt !== undefined && mono < this.lastIndexAt) this.lastIndexAt = undefined;
    const indexDue = this.lastIndexAt === undefined || mono - this.lastIndexAt >= INDEX_INTERVAL;
    if (!this.fresh()) return;
    const sessionNow = this.sessionNow();
    const wallNow = this.now();
    const at = this.outcome.rowAt;
    const clock = this.outcome.date;
    // A row older than a few minutes (a meter that came back) is dated:
    // Gladys files it at its own time, never as new.
    const age = at !== undefined && clock !== undefined ? clock - at : undefined;
    const dated =
      age !== undefined && age > DATED_AFTER ? new Date(wallNow - age).toISOString() : undefined;
    let left = this.budget(mono);
    const live = [];
    const counters = [];
    const samples = this.memory.samples;
    let countersSent = false;
    for (const sample of this.currentSamples()) {
      const created = this.createdDevice(sample.platformId);
      if (!created) continue;
      const known = at !== undefined && samples[sample.platformId] === at;
      const recount = this.recount.has(sample.platformId);
      // A row already sent: only its counters (once a minute, or those the
      // user just accepted) go again, never its plain values.
      if (known && !indexDue && !recount) continue;
      const features = keysOfDevice(sample.kind, created);
      const only = (states) =>
        states.filter((s) => features.has(s.device_feature_external_id.split(':').at(-1)));
      const values = known
        ? []
        : only(liveStates(this.gladys, sample)).map((s) =>
            dated ? { ...s, created_at: dated } : s,
          );
      const due =
        (indexDue || recount) && !this.storeError
          ? countersOf(sample).filter(
              (e) => features.has(e.key) && finite(sample.counter) && sample.counter > 0,
            )
          : [];
      if (values.length === 0 && due.length === 0) continue;
      // Out of budget: this device waits for the next read, its guards untouched.
      if (values.length + due.length > left) break;
      const sums = [];
      for (const e of due) {
        const id = `${sample.platformId}|${e.key}`;
        const guard = this.guardOf(sample.platformId, e.key, created, e.limits);
        const value = sample.counter;
        if (EgaugeApp.smallNetDrop(sample, guard, value)) continue;
        const plausible = guard.accept(value, sessionNow);
        this.logHold(id, guard);
        if (plausible) sums.push(...counterState(this.gladys, sample.platformId, e.key, value));
      }
      if (due.length > 0) countersSent = true;
      left -= values.length + sums.length;
      live.push(...values);
      counters.push(...sums);
      if (at !== undefined) samples[sample.platformId] = at;
      this.recount.delete(sample.platformId);
    }
    if (indexDue && countersSent) this.lastIndexAt = mono;
    let states = live;
    const saved = await this.saveState();
    if (gone()) return;
    if (saved && !this.storeError) states = [...live, ...counters];
    if (states.length > 0) {
      this.sent.push({ at: mono, count: states.length });
      await this.gladys
        .publishChangedStates(states)
        .catch((err) => this.logger.warn(`Publishing the meter values failed (${err?.name})`));
      if (gone()) return;
    }
    await this.publishBadges();
  }

  /**
   * The badge of each created device: degraded (orange) while one of its
   * counters is held, local otherwise. Sent when it changes, and at each start.
   */
  async publishBadges() {
    const held = new Set(this.heldList().map((h) => h.platformId));
    const badges = [];
    for (const platformId of this.knownPlatforms()) {
      if (!this.createdDevice(platformId)) continue;
      badges.push({
        external_id: ids(this.gladys, platformId).device,
        transport: 'local',
        ...(held.has(platformId) ? { degraded: true, message: T.badgeHeld } : {}),
      });
    }
    const key = JSON.stringify(badges);
    if (badges.length === 0 || key === this.lastBadges) return;
    this.lastBadges = key;
    await this.gladys
      .publishTransports(badges)
      .catch((err) => this.logger.warn(`Publishing the device badges failed (${err?.name})`));
  }

  // --- Devices -----------------------------------------------------------------------

  /** Every platform id known: seen in /data, read now, or created. */
  knownPlatforms() {
    const set = new Set(Object.keys(this.memory.seen));
    for (const sample of this.currentSamples()) set.add(sample.platformId);
    const prefix = ids(this.gladys, '').device;
    for (const d of this.gladys.devices ?? []) {
      const id = String(d.external_id ?? '');
      if (id.startsWith(prefix) && PLATFORM_ID.test(id.slice(prefix.length))) {
        set.add(id.slice(prefix.length));
      }
    }
    return [...set];
  }

  /** The devices offered: what each showed (or kept in /data), with its created features. */
  async discover() {
    if (!this.session?.client) return;
    const current = new Map(this.currentSamples().map((s) => [s.platformId, s]));
    const devices = [];
    for (const platformId of this.knownPlatforms()) {
      const kind = kindOfPlatform(platformId);
      const seen = this.memory.seen[platformId];
      const created = this.createdDevice(platformId);
      const keys = union(validKeys(kind, seen?.keys), keysOfDevice(kind, created));
      if (keys.size === 0) continue;
      const sample = current.get(platformId);
      const name = sample?.name ?? seen?.name;
      const params = [
        { name: 'register', value: name ?? '' },
        { name: 'address', value: addressOf(this.config) },
      ];
      devices.push(buildDevice(this.gladys, { platformId, kind, name }, keys, params));
    }
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) => this.logger.warn(`Publishing the meter devices failed (${err?.name})`));
  }

  /** The Discover tab asks: the known devices, never a read (the next one comes at its time). */
  async scan() {
    await this.discover();
  }

  /** The platform id of a device external id of this integration, or undefined. */
  platformOf(externalId) {
    const prefix = ids(this.gladys, '').device;
    const id = String(externalId ?? '');
    const platformId = id.startsWith(prefix) ? id.slice(prefix.length) : '';
    return PLATFORM_ID.test(platformId) ? platformId : undefined;
  }

  /**
   * A device created (or deleted): it has no reference of its counters yet
   * (nor a state kept for a deleted device of the same id): nothing can be
   * counted twice. Its values come with the next row (a row already sent is
   * never sent again as new).
   */
  async onDeviceCreated(device) {
    const platformId = this.platformOf(device?.external_id);
    if (!platformId) return;
    for (const id of [...this.guards.keys(), ...Object.keys(this.memory.counters)]) {
      if (id.startsWith(`${platformId}|`)) this.forgetCounter(id);
    }
    this.pendingAccept = undefined;
    this.lastIndexAt = undefined;
    await this.saveState();
    await this.updateStatus();
  }

  async onDeviceDeleted(device) {
    await this.onDeviceCreated(device);
  }

  async onDeviceUpdated(device) {
    const platformId = this.platformOf(device?.external_id);
    if (!platformId) return;
    // New features (Update in Discovery): their values at the next row
    // (the current one is never sent again as new).
    this.lastIndexAt = undefined;
    await this.updateStatus();
  }

  // --- /data -------------------------------------------------------------------------

  /**
   * Keeps the pin, the identity, the pause, the refusal, the last read, the
   * registers seen, the rows and the guards (their dates on the wall clock
   * of now). Never writes over a /data it could not read.
   * @returns {Promise<boolean>} whether /data holds the state now.
   */
  async saveState() {
    if (this.storeError) return false;
    const m = this.memory;
    const offset = this.now() - this.sessionNow();
    const toWall = (ref) => (ref && finite(ref.at) ? { ...ref, at: ref.at + offset } : null);
    for (const [id, { guard, device }] of this.guards) {
      const state = guard.state();
      m.counters[id] = {
        ...(device !== undefined ? { device } : {}),
        last: toWall(state.last),
        held: toWall(state.held),
      };
    }
    const p = m.pause;
    const state = {
      salt: m.salt,
      pins: m.pins,
      certSeen: m.certSeen ?? null,
      identity: m.identity ?? null,
      pause: p
        ? { key: p.key, until: p.until, count: p.count, code: p.code, status: p.status }
        : null,
      refused: m.refused ?? null,
      lastAttemptAt: this.lastAttemptAt ?? null,
      seen: m.seen,
      counters: m.counters,
      samples: m.samples,
    };
    const key = JSON.stringify(state);
    if (key === this.savedKey) return true;
    try {
      await this.store.save(state);
      this.savedKey = key;
      if (this.saveFailed) {
        this.saveFailed = false;
        this.logger.info('egauge: /data is written again');
      }
      return true;
    } catch (err) {
      if (!this.saveFailed) {
        this.logger.warn(`egauge: saving /data failed (${err?.code ?? 'error'})`);
      }
      this.saveFailed = true;
      return false;
    }
  }

  // --- Status ------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed (${err?.name ?? 'Error'})`));
  }

  async updateStatus() {
    const [connected, message] = this.currentStatus();
    await this.setStatus(connected, message);
  }

  /** The counters held back: `{ id, platformId, key, name, direction, from, to, threshold }`. */
  heldList() {
    const list = [];
    for (const [id, { guard }] of this.guards) {
      const held = guard.held;
      if (!held) continue;
      const [platformId, key] = id.split('|');
      list.push({
        id,
        platformId,
        key,
        name: this.memory.seen[platformId]?.name ?? platformId,
        direction: held.direction,
        from: held.from,
        to: held.to,
        threshold: held.threshold,
      });
    }
    return list.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Notes shown with every status: /data, the counters held, the lists of registers. */
  standingNotes() {
    const notes = [];
    if (this.storeError) notes.push(T.notes.storeUnreadable(this.storeError.code));
    else if (this.saveFailed) notes.push(T.notes.saveFailed);
    if (this.config.registersError) notes.push(T.notes.badLists(this.config.registersError));
    const held = this.heldList();
    if (held.length > 0) notes.push(T.notes.held(held));
    return notes;
  }

  /** The status from what is known now: never a read. */
  currentStatus() {
    const config = this.config;
    if (!this.session?.client) {
      if (config.hostError === 'missing') return [false, T.incomplete];
      if (config.hostError === 'http') return [false, T.badAddressHttp];
      if (config.hostError) return [false, T.badAddress];
      if (config.usernameInvalid) return [false, T.badUsername];
      if (config.passwordInvalid) return [false, T.badPassword];
      if (config.fingerprint === null) return [false, T.badFingerprint];
      return [false, T.incomplete];
    }
    const address = addressOf(config);
    const mono = this.monotonic();
    const notes = this.standingNotes();
    const m = this.memory;
    if (this.refusedApplies()) return [false, T.refused(address, notes)];
    const left = this.pauseLeft(mono);
    if (left > 0) return [false, T.paused(address, m.pause, left, notes)];
    if (m.certSeen && m.certSeen.key === this.session.key) {
      const typed = Boolean(config.fingerprint);
      const pinned = Boolean(m.pins[this.session.key]);
      return [false, T.certificate(address, m.certSeen.seen, { typed, pinned }, notes)];
    }
    if (this.lastError && this.failures > 0) {
      const wait = Math.max(0, (this.nextTryAt ?? 0) - mono);
      return [false, T.unreachable(address, this.lastError, wait, notes)];
    }
    if (this.outcome?.kind === 'reading') {
      if (this.identityState === 'other') return [false, T.otherMeter(address, notes)];
      if (this.identityState === 'unreadable') return [false, T.noIdentity(address, notes)];
      const extra = [];
      if (this.outcome.unsupported > 0) extra.push(T.notes.unsupported(this.outcome.unsupported));
      if (this.outcome.missing.length > 0) extra.push(T.notes.missing(this.outcome.missing));
      if (!this.fresh()) extra.push(T.notes.stale);
      const notCreated = this.knownPlatforms().filter(
        (p) => this.memory.seen[p] && !this.createdDevice(p),
      ).length;
      if (notCreated > 0) extra.push(T.notes.noDevice(notCreated));
      return [true, T.ok(address, this.outcome.samples.length, [...extra, ...notes])];
    }
    return [false, T.waiting(address, notes)];
  }

  // --- Configuration screen buttons -------------------------------------------------

  /**
   * "Accept the held values", in two clicks (as gladys-sunpower-pvs,
   * approved): the first lists every counter held and another meter met, and
   * accepts nothing; the second, 3 s to 5 min later in the same session,
   * accepts exactly what the first listed, each only when it still shows the
   * same thing (a counter: same direction and start, the value shown or what
   * may have been measured since, src/guard.js; a meter: the same one). A
   * drop is accepted too: a counter set back or a meter replaced is a way
   * out, never taken without the user. A save of the form never accepts.
   */
  async acceptHeld() {
    const list = this.heldList();
    const other = this.identityState === 'other' ? this.otherIdentity : undefined;
    const mono = this.monotonic();
    const sessionNow = this.sessionNow();
    const pending = this.pendingAccept;
    this.pendingAccept = undefined;
    const elapsed = pending ? mono - pending.at : undefined;
    if (
      !pending ||
      pending.session !== this.session ||
      elapsed > CONFIRM_WITHIN ||
      elapsed < CONFIRM_AFTER
    ) {
      if (list.length === 0 && !other) return T.accept.nothing;
      this.pendingAccept = { at: mono, listedAt: sessionNow, list, other, session: this.session };
      return T.accept.confirm(list, Boolean(other), CONFIRM_WITHIN);
    }
    const accepted = [];
    const changed = [];
    for (const entry of pending.list) {
      const guard = this.guards.get(entry.id)?.guard;
      const held = guard?.held;
      const margin = guard ? guard.margin(pending.listedAt, sessionNow) : 0;
      const same =
        held &&
        held.direction === entry.direction &&
        held.from === entry.from &&
        (entry.direction === 'up'
          ? held.threshold === entry.threshold &&
            held.to >= entry.to &&
            held.to - entry.to <= margin
          : Math.abs(held.to - entry.to) <= margin);
      if (same && guard.acceptHeld()) {
        accepted.push({ ...entry, to: held.to });
        this.logger.info(
          `egauge: a lifetime counter ${entry.direction === 'down' ? 'drop' : 'jump'} accepted by the user (${entry.id})`,
        );
      } else if (held) {
        changed.push(entry);
      }
    }
    let meterAccepted = false;
    if (pending.other && pending.other === this.otherIdentity && this.identityState === 'other') {
      const before = this.memory.identity;
      this.memory.identity = pending.other;
      if (await this.saveState()) {
        meterAccepted = true;
        this.identityState = undefined;
        this.otherIdentity = undefined;
        this.memory.samples = {};
        this.logger.info('egauge: the new meter accepted by the user');
      } else {
        this.memory.identity = before;
      }
    }
    if (accepted.length === 0 && changed.length === 0 && !meterAccepted) return T.accept.nothing;
    // Published at the next read (never a read sooner than the interval).
    this.lastIndexAt = undefined;
    for (const entry of accepted) this.recount.add(entry.platformId);
    await this.saveState();
    await this.updateStatus();
    return T.accept.done(accepted, changed, meterAccepted, pending.other && !meterAccepted);
  }

  /**
   * The test button: never a read sooner than the pace allows. When a read
   * is due, this click makes it (even with a login refused before: only a
   * success lifts the refusal); otherwise it tells the last one.
   */
  async testConnection() {
    if (!this.session?.client) return this.currentStatus()[1];
    const mono = this.monotonic();
    if (this.pauseLeft(mono) > 0) return this.currentStatus()[1];
    if (this.busy || this.dueAt(mono) > mono) return this.describeOutcome();
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(T.test.slow), TEST_ANSWER_WITHIN);
    });
    try {
      return await Promise.race([
        this.tick({ evenRefused: true }).then(() => this.describeOutcome(mono)),
        late,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
      if (this.running) this.schedule();
    }
  }

  /** The last read in words, and the time to the next one. */
  describeOutcome(since) {
    const mono = this.monotonic();
    const refused = this.refusedApplies();
    const next = refused ? undefined : Math.max(0, this.dueAt(mono) - mono);
    const outcome = this.outcome;
    if (!outcome) {
      return refused ? this.currentStatus()[1] : T.test.notYet(next, POLL_INTERVAL);
    }
    const ago =
      since !== undefined && outcome.at >= since ? undefined : Math.max(0, mono - outcome.at);
    if (outcome.kind === 'reading') {
      if (this.identityState !== 'ok') return this.currentStatus()[1];
      const powers = outcome.samples.filter((s) => s.kind === 'power').length;
      return T.test.reading({ registers: outcome.samples.length, powers }, ago, next);
    }
    if (isCertificate(outcome.err)) return this.currentStatus()[1];
    return T.test.failed(addressOf(this.config), outcome.err, ago, next);
  }
}
