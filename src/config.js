// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized: the
// address of the meter, the user name and password of a meter account, the
// fingerprint of its certificate when the user types it, and the registers
// counted by the Gladys energy monitoring. No key starts with `gladys_`. The
// address and fingerprint parsers come from gladys-sunpower-pvs (approved).
// -----------------------------------------------------------------------------

import { DEFAULT_PORT } from './constants.js';
import { validName } from './egauge/model.js';

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;
/** A control character (a newline pasted with the password). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;
/** Names in one register list, at most. */
const MAX_LISTED = 200;

/** The port: an integer 1-65535, or null. */
export function parsePort(value) {
  if (!/^\d{1,5}$/.test(value ?? '')) return null;
  const n = Number(value);
  return n > 0 && n < 65536 ? n : null;
}

/**
 * The meter: an IPv4 address, a host name or an IPv6 address (brackets
 * allowed), with an optional port. An address pasted from a browser
 * (`https://192.168.1.30/`) is read as its host and port. Plain HTTP,
 * credentials, a path, a query are refused.
 *   -> { host, port } or { error: 'missing' | 'invalid' | 'http' }
 */
export function parseHost(value) {
  let raw = text(value);
  if (!raw) return { error: 'missing' };
  if (raw.length > 300) return { error: 'invalid' };
  let port = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { error: 'invalid' };
    }
    if (url.protocol === 'http:') return { error: 'http' };
    if (url.protocol !== 'https:') return { error: 'invalid' };
    if (url.username || url.password || url.search || url.hash) return { error: 'invalid' };
    if (url.pathname !== '/' && url.pathname !== '') return { error: 'invalid' };
    port = url.port ? Number(url.port) : null;
    raw = url.hostname;
  } else {
    if (raw.includes('@') || raw.includes('/')) return { error: 'invalid' };
    const match = /^([^:[\]/]+):(\d{1,5})$/.exec(raw) ?? /^\[([^\]]+)\]:(\d{1,5})$/.exec(raw);
    if (match) {
      raw = match[1];
      port = parsePort(match[2]);
      if (port === null) return { error: 'invalid' };
    }
  }
  const host = raw.replace(/^\[(.*)\]$/, '$1');
  if (IPV4.test(host)) {
    const parts = host.split('.').map(Number);
    if (!parts.every((n) => n <= 255)) return { error: 'invalid' };
    // Never a broadcast, a multicast nor "any" address.
    if (parts[0] === 0 || parts[0] >= 224 || parts[3] === 255) return { error: 'invalid' };
    return { host, port };
  }
  if (host.includes(':')) {
    if (!IPV6.test(host) || /^ff/i.test(host) || host === '::') return { error: 'invalid' };
    return { host: host.toLowerCase(), port };
  }
  return HOSTNAME.test(host)
    ? { host: host.toLowerCase().replace(/\.$/, ''), port }
    : { error: 'invalid' };
}

/**
 * A SHA-256 fingerprint as typed (colons, spaces or nothing between the
 * bytes, any case) -> `AA:BB:...` (Node's `fingerprint256`), '' when empty,
 * null when it is not 32 bytes of hex.
 */
export function parseFingerprint(value) {
  const raw = text(value).replace(/^sha-?256\s*[:=]?\s*/i, '');
  if (!raw) return '';
  const hex = raw.replace(/[\s:-]/g, '');
  if (!/^[0-9A-Fa-f]{64}$/.test(hex)) return null;
  return hex.toUpperCase().match(/../g).join(':');
}

/**
 * A list of register names, separated by commas (a register name never holds
 * one: WebAPI glossary). -> `{ names: string[] }` or `{ error: 'invalid' }`.
 */
export function parseRegisterList(value) {
  const raw = typeof value === 'string' ? value : '';
  if (raw.length > 10_000) return { error: 'invalid' };
  const names = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (name === '') continue;
    if (!validName(name)) return { error: 'invalid' };
    if (!names.includes(name)) names.push(name);
  }
  return names.length > MAX_LISTED ? { error: 'invalid' } : { names };
}

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const target = parseHost(raw.address);
  const username = text(raw.username);
  // The password is kept as typed (never trimmed).
  const password = typeof raw.password === 'string' ? raw.password : '';
  const consumption = parseRegisterList(raw.consumption_registers);
  const production = parseRegisterList(raw.production_registers);
  const both =
    consumption.names && production.names
      ? consumption.names.filter((n) => production.names.includes(n))
      : [];
  let registersError = null;
  if (consumption.error || production.error) registersError = 'invalid';
  else if (both.length > 0) registersError = 'both';
  return {
    host: target.error ? null : target.host,
    hostError: target.error ?? null,
    port: target.port ?? DEFAULT_PORT,
    username,
    usernameInvalid: username === '' || username.length > 64 || CONTROL.test(username),
    password,
    // Empty, a newline or a control character pasted with it: said, never sent.
    passwordInvalid: password === '' || CONTROL.test(password) || password.length > 128,
    /** The fingerprint typed: '' none, null invalid. */
    fingerprint: parseFingerprint(raw.certificate_fingerprint),
    /** The registers counted by the energy monitoring (none when the lists are wrong). */
    consumption: registersError ? [] : consumption.names,
    production: registersError ? [] : production.names,
    registersError,
  };
}

/** `host:port`: the key of the pin, the refusal and the pause in /data. */
export const targetKey = (config) =>
  config.host?.includes(':') ? `[${config.host}]:${config.port}` : `${config.host}:${config.port}`;

/** The address as shown to the user (the port only when it is not 443). */
export const addressOf = (config) => {
  const host = config.host?.includes(':') ? `[${config.host}]` : config.host;
  return config.port === DEFAULT_PORT ? host : `${host}:${config.port}`;
};

/** Whether the form is complete enough to read the meter. */
export const isComplete = (config) =>
  Boolean(config.host) &&
  !config.usernameInvalid &&
  !config.passwordInvalid &&
  config.fingerprint !== null;
