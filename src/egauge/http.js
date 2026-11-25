// -----------------------------------------------------------------------------
// The only network access of the integration: one HTTPS request to the meter
// on node:https. A deadline for the whole exchange, a size cap on the body
// (checked chunk by chunk, before the answer is complete), no redirect
// followed (the token never goes anywhere else), no connection reused
// (`agent: false`, and never a custom `createConnection`: Node would then
// ignore it and open a second socket). Taken from gladys-sunpower-pvs
// (approved), with a JSON body for the login.
//
// An eGauge meter reached by its address on the LAN shows a self-signed
// certificate: no authority can vouch for it. It is checked by its SHA-256
// fingerprint instead, right after the TLS handshake and BEFORE a single byte
// of the request (headers, token, digest) is written: `checkPeer(fingerprint)`
// (async) decides. What it throws is rethrown marked `notSent`. An answer
// that comes before the request was written is never read. The verification
// by an authority is off for THIS request only (`rejectUnauthorized: false`
// in its own options), never for the process.
//
// Resolves { status, headers, body } for any status; rejects an EgaugeError
// for the transport failures, whose message never holds the address (Node's
// messages do).
// -----------------------------------------------------------------------------

import https from 'node:https';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { USER_AGENT } from '../constants.js';
import { CODES, EgaugeError } from './errors.js';

function transportError(err, sent) {
  const code = String(err?.code ?? '');
  const text = String(err?.message ?? '').toLowerCase();
  if (code === 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE' || text.includes('handshake failure')) {
    return new EgaugeError(CODES.TLS, 'TLS handshake refused', { notSent: !sent });
  }
  // Something answered, but not in HTTP or TLS (a wrong port, the wrong protocol).
  if (code.startsWith('HPE_') || code === 'EPROTO' || code.startsWith('ERR_SSL')) {
    return new EgaugeError(CODES.BAD_ANSWER, `Not the expected protocol (${code})`, {
      notSent: !sent,
    });
  }
  return new EgaugeError(
    CODES.UNREACHABLE,
    /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'Connection failed',
    { notSent: !sent },
  );
}

const bareHost = (host) => host.replace(/^\[(.*)\]$/, '$1');

/**
 * @param {{ host: string, port: number, path: string }} target
 * @param {object} options
 * @param {'GET'|'POST'} [options.method]
 * @param {Buffer} [options.body] a JSON body (POST)
 * @param {Record<string, string>} [options.headers]
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} options.maxBytes body size cap
 * @param {(fingerprint: string) => Promise<void>|void} options.checkPeer
 */
export function httpsRequest(
  { host, port, path },
  { method = 'GET', body, headers = {}, timeout, maxBytes, checkPeer },
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let early = false;
    let req = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new EgaugeError(CODES.TIMEOUT, `No answer within ${Math.round(timeout / 1000)} s`, {
            notSent: !sent,
          }),
        ),
      timeout,
    );

    /** TLS is up: the certificate first, then the request. */
    const ready = async (socket) => {
      if (settled) return;
      const fingerprint = socket.getPeerCertificate?.()?.fingerprint256 ?? null;
      try {
        if (!fingerprint) {
          throw new EgaugeError(CODES.BAD_ANSWER, 'No certificate');
        }
        await checkPeer(fingerprint);
        if (settled) return;
        if (early) throw new EgaugeError(CODES.BAD_ANSWER, 'Answer before the request');
      } catch (err) {
        finish(Object.assign(err, { notSent: true }));
        return;
      }
      sent = true;
      if (body) req.end(body);
      else req.end();
    };

    try {
      const bare = bareHost(host);
      const options = {
        method,
        host: bare,
        port,
        path,
        agent: false,
        // Self-signed: checked by its fingerprint above, not by an authority.
        rejectUnauthorized: false,
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...(body
            ? { 'content-type': 'application/json', 'content-length': String(body.length) }
            : {}),
          ...headers,
        },
      };
      if (!isIP(bare)) options.servername = bare;
      req = https.request(options, (res) => {
        // An answer before the request was written (the peer spoke first,
        // while its certificate was still being checked): never accepted.
        if (!sent) {
          early = true;
          res.resume();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new EgaugeError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', (err) => finish(transportError(err, sent)));
      });
      req.on('socket', (socket) => socket.once('secureConnect', () => ready(socket)));
      req.on('error', (err) => finish(transportError(err, sent)));
    } catch (err) {
      // https.request throws synchronously on a value it refuses: a failure,
      // never a crash.
      finish(transportError(err, false));
    }
  });
}

/**
 * A TLS handshake only, to read the fingerprint of the certificate the meter
 * shows now ("Trust the certificate"): not a single byte is written after
 * the handshake, the socket is closed at once. Resolves the fingerprint.
 */
export function probeCertificate({ host, port }, { timeout }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new EgaugeError(CODES.TIMEOUT, 'No handshake', { notSent: true })),
      timeout,
    );
    try {
      const bare = bareHost(host);
      socket = tls.connect({
        host: bare,
        port,
        rejectUnauthorized: false,
        ...(isIP(bare) ? {} : { servername: bare }),
      });
      socket.once('secureConnect', () => {
        const fingerprint = socket.getPeerCertificate?.()?.fingerprint256 ?? null;
        if (fingerprint) finish(null, fingerprint);
        else finish(new EgaugeError(CODES.BAD_ANSWER, 'No certificate', { notSent: true }));
      });
      socket.on('error', (err) => finish(transportError(err, false)));
      // Whatever the peer writes is never read.
      socket.on('data', () => {});
    } catch (err) {
      finish(transportError(err, false));
    }
  });
}
