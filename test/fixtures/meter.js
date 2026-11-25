// -----------------------------------------------------------------------------
// A fake eGauge meter at the transport level (src/egauge/http.js replaced):
// the WebAPI as its documentation (webapi.egauge.net) shows it — the digest
// login, the JWT, /api/sys/sn, /api/register with `raw`, `rate`,
// `virtual=value` and `time=now` — its registers after the example of the
// documentation (`use` virtual, `Grid`, `Solar`) and the register name
// suffixes of its glossary (`+`, `-`).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

/** 2026-04-10T11:30:00Z. */
export const NOW = Date.UTC(2026, 3, 10, 11, 30, 0);
export const SERIAL = 'G10400';
export const USERNAME = 'reader';
export const PASSWORD = 'S3cret-pass!';
export const REALM = 'eGauge Administration';
export const FP =
  'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
export const OTHER_FP =
  '11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF';
export const HOST = '192.168.1.30';

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');
/** kWh -> the W·s of the meter, as a BigInt. */
export const ws = (kwh) => BigInt(Math.round(kwh * 3_600_000));

/** The registers of the fake meter (indices as the documentation's example: virtual first). */
export const registers = () => [
  { name: 'use', type: 'P', idx: 0, rate: 1802, cumul: ws(12_000) },
  { name: 'gen', type: 'P', idx: 1, rate: 2500, cumul: ws(8_000) },
  { name: 'Grid', type: 'P', idx: 17, did: 0, rate: -698, cumul: ws(4_000) },
  { name: 'Solar', type: 'P', idx: 18, did: 1, rate: 2500, cumul: ws(8_000) },
  { name: 'Solar+', type: 'P', idx: 19, did: 2, rate: 2500, cumul: ws(8_100) },
  { name: 'Grid-', type: 'P', idx: 20, did: 3, rate: -698, cumul: -ws(3_000) },
  { name: 'Kitchen', type: 'P', idx: 21, did: 4, rate: 120, cumul: ws(900) },
  { name: 'L1 Voltage', type: 'V', idx: 22, did: 5, rate: 231.4, cumul: 0n },
  { name: 'Attic', type: 'T', idx: 23, did: 6, rate: 31.25, cumul: 0n },
  { name: 'Humidity', type: 'h', idx: 24, did: 7, rate: 55.1, cumul: 0n },
];

export const json = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
});

/**
 * The fake meter. Its state is plain data the tests change live: `regs`
 * (the registers, `cumul` a BigInt in W·s), `serial`, `fingerprint`,
 * `rowAt` (the time of its latest row, ms; defaults to the clock),
 * `dateHeader` (a function of the clock, or null), `hook(path, request)` (an
 * answer, a thrown error, a promise: a slow meter), `loginReply` (a forced
 * answer of the login).
 */
export function createMeter({
  clock = { now: NOW },
  username = USERNAME,
  password = PASSWORD,
} = {}) {
  let tokens = 0;
  let nonces = 0;
  const meter = {
    clock,
    username,
    password,
    serial: SERIAL,
    /** The account has the `view_settings` privilege (it may read /api/sys/sn). */
    viewSettings: true,
    fingerprint: FP,
    regs: registers(),
    rowAt: undefined,
    tokens: new Set(),
    nonces: new Set(),
    requests: [],
    peers: 0,
    dateHeader: (now) => new Date(now).toUTCString(),
    hook: undefined,
    loginReply: undefined,
    count: (prefix) => meter.requests.filter((r) => r.path.startsWith(prefix)).length,
    expire() {
      meter.tokens.clear();
    },
    /** `seconds` of the current rates accumulated in every register. */
    run(seconds) {
      for (const r of meter.regs) {
        if (r.type === 'P') r.cumul += BigInt(Math.round(r.rate * seconds));
      }
    },
    reg: (name) => meter.regs.find((r) => r.name === name),
    /** The answer of /api/register (registers listed in `order`, default by index). */
    registerAnswer() {
      const sorted = [...meter.regs].sort((a, b) => a.idx - b.idx);
      const at = (meter.rowAt ?? meter.clock.now) / 1000;
      return {
        ts: at.toFixed(6),
        registers: (meter.order ? meter.order(sorted) : sorted).map((r) => ({
          name: r.name,
          type: r.type,
          idx: r.idx,
          ...(r.did !== undefined ? { did: r.did } : {}),
          ...(r.rate !== undefined ? { rate: r.rate } : {}),
        })),
        ranges: [{ ts: at.toFixed(9), delta: 1, rows: [sorted.map((r) => String(r.cumul))] }],
      };
    },
  };
  meter.request = async (target, options) => {
    // The certificate first, before anything is written (src/egauge/http.js).
    meter.peers += 1;
    try {
      await options.checkPeer(meter.fingerprint);
    } catch (err) {
      throw Object.assign(err, { notSent: true });
    }
    const path = target.path;
    const headers = options.headers ?? {};
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body.toString('utf8')) : undefined;
    meter.requests.push({ method, path, headers: { ...headers }, body, at: meter.clock.now });
    if (meter.hook) {
      const answer = await meter.hook(path, { headers, body, method, target, options });
      if (answer !== undefined) return answer;
    }
    const date = meter.dateHeader ? { date: meter.dateHeader(meter.clock.now) } : {};
    const challenge = () => {
      nonces += 1;
      const nnc = `nonce${nonces}`;
      meter.nonces.add(nnc);
      return json(401, { rlm: REALM, nnc, error: 'Authentication required.' }, date);
    };
    if (path === '/api/auth/unauthorized' && method === 'GET') return challenge();
    if (path === '/api/auth/login' && method === 'POST') {
      if (meter.loginReply) return meter.loginReply(body, date);
      if (!body || body.rlm !== REALM || !meter.nonces.has(body.nnc)) {
        return json(200, { error: 'Nonce expired.' }, date);
      }
      meter.nonces.delete(body.nnc);
      const ha1 = md5(`${meter.username}:${REALM}:${meter.password}`);
      const hash = md5(`${ha1}:${body.nnc}:${body.cnnc}`);
      if (body.usr !== meter.username || body.hash !== hash) {
        return json(401, { rlm: REALM, nnc: 'x', error: 'Invalid credentials.' }, date);
      }
      tokens += 1;
      const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJ0b2siOiR${tokens}.c2lnbmF0dXJl`;
      meter.tokens.add(jwt);
      return json(200, { jwt, rights: ['view_settings'] }, date);
    }
    const bearer = /^Bearer (.+)$/.exec(String(headers.authorization ?? ''))?.[1];
    if (!bearer || !meter.tokens.has(bearer)) return challenge();
    if (path === '/api/sys/sn' && method === 'GET') {
      // `/sys` needs the `view_settings` privilege (WebAPI). The refusal in
      // the two documented shapes (a 200 with `error`, a 401) and a 403.
      if (!meter.viewSettings) {
        if (meter.snRefusal === '200')
          return json(200, { error: 'Insufficient privileges.' }, date);
        if (meter.snRefusal === '401') return challenge();
        return json(403, { error: 'Insufficient privileges.' }, date);
      }
      return json(200, { result: meter.serial }, date);
    }
    if (path === '/api/register?raw&rate&virtual=value&time=now' && method === 'GET') {
      return json(200, meter.registerAnswer(), date);
    }
    return json(404, { error: 'Not found' }, date);
  };
  return meter;
}
