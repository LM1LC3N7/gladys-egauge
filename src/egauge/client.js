// -----------------------------------------------------------------------------
// The eGauge WebAPI of one meter, after its documentation (webapi.egauge.net)
// and egauge-python (MIT, eGauge Systems LLC; see THIRD_PARTY_NOTICES.md):
//
//   GET  /api/auth/unauthorized   401 { rlm, nnc }: the realm, a server nonce
//   POST /api/auth/login          { rlm, usr, nnc, cnnc, hash } -> { jwt }
//                                 hash = MD5(MD5(usr:rlm:pwd):nnc:cnnc): the
//                                 password itself never leaves Gladys
//   GET  /api/sys/sn              the serial number (identity), with the JWT
//   GET  /api/register?...        the registers, with the JWT
//
// Read only: no other path is ever asked (`/api/cmd`, `/api/config` never;
// the paths are the constants of src/constants.js). The user name, the
// password and the token stay in private fields of this object: never in a
// log, an error, a status or /data.
//
// The token is used again for 8 minutes (the meter gives about 10). A route
// refused (401, 403) with a token used before (expired, the meter rebooted)
// opens a new one once in the same read; refused again right after a login,
// it is CODES.ACCESS, never a refusal of the password. Only the login itself
// refuses the password: HTTP 401/403 on /api/auth/login, or an `error` in its
// answer, other than an expired nonce (an expired nonce, in a 200 or a 401:
// one new try). `/api/sys/sn` needs the `view_settings` right: refused, it
// is CODES.ACCESS and the token is kept for the registers (src/app.js then
// identifies the meter by its certificate). Every
// request goes through `checkPeer` (src/egauge/http.js).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import {
  PATHS,
  REGISTER_BYTES,
  REQUEST_TIMEOUT,
  SMALL_BYTES,
  TOKEN_MAX_AGE,
} from '../constants.js';
import { CODES, EgaugeError } from './errors.js';
import { httpsRequest } from './http.js';
import { challengeOf, loginReplyOf, parseRegisters, serialOf } from './model.js';

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

/** The digest hash of the WebAPI login (egauge-python, JWTAuth.handle_401). */
export function digestHash({ usr, rlm, pwd, nnc, cnnc }) {
  return md5(`${md5(`${usr}:${rlm}:${pwd}`)}:${nnc}:${cnnc}`);
}

/** The Retry-After of an answer, in ms (seconds only), or undefined. */
function retryAfterOf(headers) {
  const value = headers?.['retry-after'];
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}

/** The time of the meter from the `Date` header of an answer (ms), or undefined. */
export function dateOf(headers) {
  const value = headers?.date;
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

export class EgaugeClient {
  #username;
  #password;
  /** The JWT of the open session, or null; `#tokenAt` its monotonic date. */
  #token = null;
  #tokenAt = 0;
  /** The token with which `/api/sys/sn` was refused (an account without `view_settings`). */
  #serialRefusedFor = null;

  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} options.port
   * @param {string} options.username
   * @param {string} options.password
   * @param {(fingerprint: string) => Promise<void>|void} options.checkPeer
   * @param {() => number} [options.monotonic]
   * @param {Function} [options.request] the transport (tests inject a fake meter)
   * @param {() => string} [options.nonce] the client nonce (tests)
   */
  constructor({
    host,
    port,
    username,
    password,
    checkPeer,
    monotonic = () => performance.now(),
    request = httpsRequest,
    nonce = () => randomBytes(16).toString('hex'),
  }) {
    this.target = { host, port };
    this.#username = username;
    this.#password = password;
    this.checkPeer = checkPeer;
    this.monotonic = monotonic;
    this.request = request;
    this.nonce = nonce;
  }

  /** Forgets the token: the next request logs in again. */
  close() {
    this.#token = null;
  }

  async send(path, { method = 'GET', body, token, maxBytes, timeout }) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    return this.request(
      { ...this.target, path },
      {
        method,
        ...(body ? { body: Buffer.from(JSON.stringify(body), 'utf8') } : {}),
        headers,
        maxBytes,
        timeout: Math.max(1, Math.min(timeout ?? REQUEST_TIMEOUT, REQUEST_TIMEOUT)),
        checkPeer: this.checkPeer,
      },
    );
  }

  /** An answer that is not a success: the matching EgaugeError. */
  static failure(res, what) {
    const status = res.status;
    if (status >= 300 && status < 400) {
      return new EgaugeError(CODES.REDIRECT, `${what}: redirected (HTTP ${status})`, { status });
    }
    if (status === 429) {
      return new EgaugeError(CODES.RATE_LIMITED, `${what}: HTTP 429`, {
        status,
        retryAfter: retryAfterOf(res.headers),
      });
    }
    if (status >= 500 && status < 600) {
      return new EgaugeError(CODES.SERVER, `${what}: HTTP ${status}`, {
        status,
        retryAfter: retryAfterOf(res.headers),
      });
    }
    return new EgaugeError(CODES.HTTP, `${what}: HTTP ${status}`, { status });
  }

  /** A new token by the digest login. Throws CODES.CREDENTIALS on a refusal. */
  async login({ timeout } = {}) {
    this.#token = null;
    // An expired nonce (it lives about a minute): one new try, never more.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const challenge = await this.send(PATHS.UNAUTHORIZED, { maxBytes: SMALL_BYTES, timeout });
      if (challenge.status !== 401) {
        if (challenge.status === 200 || challenge.status === 403) {
          throw new EgaugeError(CODES.BAD_ANSWER, 'No digest challenge', {
            status: challenge.status,
          });
        }
        throw EgaugeClient.failure(challenge, 'Challenge');
      }
      const { rlm, nnc } = challengeOf(challenge.body);
      const cnnc = this.nonce();
      const usr = this.#username;
      const hash = digestHash({ usr, rlm, pwd: this.#password, nnc, cnnc });
      const res = await this.send(PATHS.LOGIN, {
        method: 'POST',
        body: { rlm, usr, nnc, cnnc, hash },
        maxBytes: SMALL_BYTES,
        timeout,
      });
      if (res.status === 401 || res.status === 403) {
        // Its body first: an expired nonce is never a refused password.
        let expired;
        try {
          expired = loginReplyOf(res.body).nonceExpired === true;
        } catch {
          expired = false;
        }
        if (expired) continue;
        throw new EgaugeError(CODES.CREDENTIALS, `Login refused (HTTP ${res.status})`, {
          status: res.status,
        });
      }
      if (res.status === 400) {
        // A request the meter does not understand: a protocol error, never a refusal.
        throw new EgaugeError(CODES.BAD_ANSWER, 'Login: HTTP 400', { status: 400 });
      }
      if (res.status !== 200) throw EgaugeClient.failure(res, 'Login');
      const reply = loginReplyOf(res.body);
      if (reply.refused) throw new EgaugeError(CODES.CREDENTIALS, 'Login refused');
      if (reply.jwt) {
        this.#token = reply.jwt;
        this.#tokenAt = this.monotonic();
        return;
      }
    }
    throw new EgaugeError(CODES.BAD_ANSWER, 'The nonce expired twice');
  }

  /** Whether the token is still young enough to be used. */
  #tokenFresh() {
    if (!this.#token) return false;
    const age = this.monotonic() - this.#tokenAt;
    return age >= 0 && age < TOKEN_MAX_AGE;
  }

  /**
   * One GET on a token (a new one when none is or it is old; again once when
   * the meter refuses a token used before). Resolves `{ body, date }`.
   */
  async get(path, { maxBytes = SMALL_BYTES, timeout, keepToken = false } = {}) {
    let fresh = false;
    if (!this.#tokenFresh()) {
      await this.login({ timeout });
      fresh = true;
    }
    for (;;) {
      const res = await this.send(path, { token: this.#token, maxBytes, timeout });
      const refused = res.status === 401 || res.status === 403;
      if (refused && !fresh) {
        // The token expired (or the meter restarted): a new one, once.
        await this.login({ timeout });
        fresh = true;
        continue;
      }
      if (refused) {
        // A route that needs a right this account lacks: the token stays good for the others.
        if (keepToken) this.#serialRefusedFor = this.#token;
        else this.#token = null;
        throw new EgaugeError(CODES.ACCESS, `Refused after login (HTTP ${res.status})`, {
          status: res.status,
        });
      }
      if (res.status !== 200) throw EgaugeClient.failure(res, 'Read');
      return { body: res.body, date: dateOf(res.headers) };
    }
  }

  /** The serial number of the meter, or undefined when the answer has none. */
  async readSerial(options) {
    // Refused with this token already: not asked again until a new one (no login per read).
    if (this.#token && this.#token === this.#serialRefusedFor && this.#tokenFresh()) {
      throw new EgaugeError(CODES.ACCESS, 'Serial number refused to this account', {
        status: 403,
      });
    }
    const { body } = await this.get(PATHS.SERIAL, { ...options, keepToken: true });
    return serialOf(body);
  }

  /** The registers: `{ at, registers, skipped, date }` (src/egauge/model.js). */
  async readRegisters(options) {
    const { body, date } = await this.get(PATHS.REGISTERS, {
      maxBytes: REGISTER_BYTES,
      ...options,
    });
    return { ...parseRegisters(body), date };
  }
}
