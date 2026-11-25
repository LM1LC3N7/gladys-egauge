// -----------------------------------------------------------------------------
// What the answers of the meter say, strict and bounded (pure). From the
// eGauge WebAPI documentation (webapi.egauge.net, Common Documentation
// License 1.0) and egauge-python (MIT, eGauge Systems LLC; see
// THIRD_PARTY_NOTICES.md: the mapping of a row to the registers, the digest).
//
// GET /api/register?raw&rate&virtual=value&time=now:
//   { ts, registers: [{ name, type, idx, did?, rate? }],
//     ranges: [{ ts, delta, rows: [[ "<value>" | { v }, ... ]] }] }
// The values of a row are listed "in order of increasing register index";
// each is a signed 64-bit integer as a decimal string, in the rate unit of
// the type multiplied by seconds (W·s for a power register `P`). A register
// without `did` is a virtual one (computed by the meter from others).
//
// Nothing here is trusted: a value that is not a decimal integer string is
// unknown (never 0), a rate that is not a finite number is unknown, a name
// with a control character is skipped, the counts are bounded, a row that
// does not match the registers is not an answer of the WebAPI.
// -----------------------------------------------------------------------------

import { MAX_NAME, MAX_REGISTERS } from '../constants.js';
import { CODES, EgaugeError } from './errors.js';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
/** A register name: no control character (nor a bidi override), bounded. */
// eslint-disable-next-line no-control-regex
const BAD_NAME = /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/;
/** A type code of the WebAPI (`P`, `V`, `#3`, `Qv`, `$`...). */
const TYPE = /^[A-Za-z#$%|]{1,4}$/;
/** A Unix timestamp as a decimal string (seconds, optional fraction). */
const TIMESTAMP = /^(\d{9,11})(?:\.(\d{1,12}))?$/;

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** JSON of a body, or a BAD_ANSWER. */
export function jsonOf(body) {
  try {
    return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
  } catch {
    throw new EgaugeError(CODES.BAD_ANSWER, 'The answer is not JSON');
  }
}

/** A WebAPI timestamp (decimal seconds) -> ms, or undefined. */
export function timeOf(value) {
  if (typeof value !== 'string' || value.length > 32) return undefined;
  const match = TIMESTAMP.exec(value);
  if (!match) return undefined;
  const fraction = match[2] ? Number(`0.${match[2]}`) : 0;
  return Number(match[1]) * 1000 + Math.round(fraction * 1000);
}

/** A cumulative value (a decimal string, or `{ v }` with a demand) -> BigInt, or undefined. */
export function cumulOf(cell) {
  const raw = isPlain(cell) ? cell.v : cell;
  if (typeof raw !== 'string' || !/^-?\d{1,19}$/.test(raw)) return undefined;
  const value = BigInt(raw);
  return value >= INT64_MIN && value <= INT64_MAX ? value : undefined;
}

/** A register name we may show and keep: trimmed of nothing, checked, bounded. */
export const validName = (name) =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= MAX_NAME &&
  name.trim() !== '' &&
  !BAD_NAME.test(name);

/**
 * The registers of one `/api/register` answer and the time of their row:
 * `{ at, registers: [{ name, type, idx, did, virtual, rate, cumul }], skipped }`.
 * `rate` (number) and `cumul` (BigInt) are undefined when unknown. Throws a
 * BAD_ANSWER (or TOO_LARGE) when the answer is not one of the WebAPI.
 */
export function parseRegisters(body) {
  const json = jsonOf(body);
  if (!isPlain(json)) throw new EgaugeError(CODES.BAD_ANSWER, 'Not a register answer');
  if (typeof json.error === 'string') {
    // The text of the meter is never quoted.
    throw new EgaugeError(CODES.BAD_ANSWER, 'The meter answered an error');
  }
  const list = json.registers;
  if (!Array.isArray(list)) throw new EgaugeError(CODES.BAD_ANSWER, 'No registers');
  if (list.length > MAX_REGISTERS) {
    throw new EgaugeError(CODES.TOO_LARGE, `More than ${MAX_REGISTERS} registers`);
  }
  const range = Array.isArray(json.ranges) ? json.ranges[0] : undefined;
  const row = isPlain(range) && Array.isArray(range.rows) ? range.rows[0] : undefined;
  if (!Array.isArray(row)) throw new EgaugeError(CODES.BAD_ANSWER, 'No row of values');
  if (row.length !== list.length) {
    throw new EgaugeError(CODES.BAD_ANSWER, 'The row does not match the registers');
  }
  const entries = [];
  const seenIdx = new Set();
  for (const reg of list) {
    if (!isPlain(reg) || !Number.isInteger(reg.idx) || reg.idx < 0 || reg.idx > 1_000_000) {
      throw new EgaugeError(CODES.BAD_ANSWER, 'A register without a valid index');
    }
    if (seenIdx.has(reg.idx)) throw new EgaugeError(CODES.BAD_ANSWER, 'Two registers, one index');
    seenIdx.add(reg.idx);
    entries.push(reg);
  }
  // The values of the row follow the increasing register index.
  entries.sort((a, b) => a.idx - b.idx);
  const registers = [];
  const names = new Set();
  let skipped = 0;
  entries.forEach((reg, i) => {
    const did = Number.isInteger(reg.did) && reg.did >= 0 && reg.did <= 1_000_000 ? reg.did : null;
    if (!validName(reg.name) || typeof reg.type !== 'string' || !TYPE.test(reg.type)) {
      skipped += 1;
      return;
    }
    if (names.has(reg.name)) {
      skipped += 1;
      return;
    }
    names.add(reg.name);
    registers.push({
      name: reg.name,
      type: reg.type,
      idx: reg.idx,
      did,
      virtual: did === null,
      rate: typeof reg.rate === 'number' && Number.isFinite(reg.rate) ? reg.rate : undefined,
      cumul: cumulOf(row[i]),
    });
  });
  return { at: timeOf(range.ts) ?? timeOf(json.ts), registers, skipped };
}

/** `{ rlm, nnc }` of a 401 answer, or a BAD_ANSWER. */
export function challengeOf(body) {
  const json = jsonOf(body);
  const ok = (value) =>
    typeof value === 'string' && value.length > 0 && value.length <= 2048 && !BAD_NAME.test(value);
  if (!isPlain(json) || !ok(json.rlm) || !ok(json.nnc)) {
    throw new EgaugeError(CODES.BAD_ANSWER, 'No digest challenge');
  }
  return { rlm: json.rlm, nnc: json.nnc };
}

/** A JWT we may send back: base64url parts, printable, bounded. */
const JWT = /^[A-Za-z0-9_-]{1,4096}(\.[A-Za-z0-9_-]{0,4096}){1,4}$/;

/**
 * The reply of `/api/auth/login`: `{ jwt }` or `{ nonceExpired: true }` or
 * `{ refused: true }` (an `error` other than an expired nonce). Anything else
 * is a BAD_ANSWER.
 */
export function loginReplyOf(body) {
  const json = jsonOf(body);
  if (!isPlain(json)) throw new EgaugeError(CODES.BAD_ANSWER, 'Not a login answer');
  if (typeof json.error === 'string') {
    // egauge-python: "Nonce expired." asks for a new nonce; any other error is a refusal.
    return /nonce/i.test(json.error) ? { nonceExpired: true } : { refused: true };
  }
  if (typeof json.jwt === 'string' && JWT.test(json.jwt)) return { jwt: json.jwt };
  throw new EgaugeError(CODES.BAD_ANSWER, 'No token in the login answer');
}

/** The serial number of `/api/sys/sn` (`{ result }`), or undefined. */
export function serialOf(body) {
  let json;
  try {
    json = jsonOf(body);
  } catch {
    return undefined;
  }
  const value = isPlain(json) ? json.result : undefined;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}
