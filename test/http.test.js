// -----------------------------------------------------------------------------
// The transport on REAL sockets (127.0.0.1): the certificate checked before a
// single byte of the request, an answer that came first never read, bounded
// answers, no redirect followed, the handshake of "Trust the certificate"
// that writes nothing; and the client end to end on the fake meter served in
// HTTPS (digest login, token, registers).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PATHS } from '../src/constants.js';
import { EgaugeClient } from '../src/egauge/client.js';
import { CODES } from '../src/egauge/errors.js';
import { httpsRequest, probeCertificate } from '../src/egauge/http.js';
import { PASSWORD, USERNAME, createMeter, ws } from './fixtures/meter.js';
import { certs, fingerprintOf, impostorServer, meterServer } from './helpers/server.js';

const DEVICE_FP = fingerprintOf(certs.device);
const target = (port, path = PATHS.UNAUTHORIZED) => ({ host: '127.0.0.1', port, path });
const options = (extra = {}) => ({ timeout: 5000, maxBytes: 64 * 1024, ...extra });

test('the certificate is checked before a byte is written; refused: nothing sent', async (t) => {
  const srv = await meterServer(createMeter());
  t.after(() => srv.close());
  await assert.rejects(
    httpsRequest(
      target(srv.port),
      options({
        checkPeer: (fp) => {
          assert.equal(fp, DEVICE_FP);
          throw Object.assign(new Error('no'), { code: CODES.CERTIFICATE });
        },
      }),
    ),
    (err) => err.code === CODES.CERTIFICATE && err.notSent === true,
  );
  assert.equal(srv.received.length, 0);
  const ok = await httpsRequest(target(srv.port), options({ checkPeer: () => {} }));
  assert.equal(ok.status, 401);
  assert.equal(srv.received.length, 1);
});

test('an answer written before the request is never read, and the request never goes', async (t) => {
  const imp = await impostorServer();
  t.after(() => imp.close());
  await assert.rejects(
    httpsRequest(
      target(imp.port),
      options({ checkPeer: () => new Promise((resolve) => setTimeout(resolve, 100)) }),
    ),
    (err) => err.code === CODES.BAD_ANSWER && err.notSent === true,
  );
  assert.equal(imp.received, 0);
});

test('a body above the cap is cut before it ends; a redirect is not followed; a silent meter times out', async (t) => {
  const srv = await meterServer(createMeter());
  t.after(() => srv.close());
  srv.mode = 'big';
  await assert.rejects(
    httpsRequest(target(srv.port), options({ checkPeer: () => {} })),
    (err) => err.code === CODES.TOO_LARGE,
  );
  srv.mode = 'redirect';
  const res = await httpsRequest(target(srv.port), options({ checkPeer: () => {} }));
  assert.equal(res.status, 302);
  assert.equal(EgaugeClient.failure(res, 'x').code, CODES.REDIRECT);
  srv.mode = 'silent';
  await assert.rejects(
    httpsRequest(target(srv.port), options({ timeout: 300, checkPeer: () => {} })),
    (err) => err.code === CODES.TIMEOUT,
  );
});

test('"Trust the certificate": a handshake only, not a byte written', async (t) => {
  const imp = await impostorServer({ quiet: true });
  t.after(() => imp.close());
  const fp = await probeCertificate({ host: '127.0.0.1', port: imp.port }, { timeout: 2000 });
  assert.equal(fp, DEVICE_FP);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(imp.received, 0);
});

test('the client over HTTPS: digest login, the password never on the wire, registers read', async (t) => {
  const meter = createMeter();
  const srv = await meterServer(meter);
  t.after(() => srv.close());
  const client = new EgaugeClient({
    host: '127.0.0.1',
    port: srv.port,
    username: USERNAME,
    password: PASSWORD,
    checkPeer: (fp) => assert.equal(fp, DEVICE_FP),
  });
  assert.equal(await client.readSerial(), meter.serial);
  const answer = await client.readRegisters();
  assert.equal(answer.registers.find((r) => r.name === 'Kitchen').cumul, ws(900));
  assert.ok(Number.isFinite(answer.date));
  const wire = srv.received
    .map((r) => `${r.path} ${JSON.stringify(r.headers)} ${r.body}`)
    .join('\n');
  assert.ok(!wire.includes(PASSWORD));
  assert.deepEqual(
    srv.received.map((r) => `${r.method} ${r.path}`),
    [
      `GET ${PATHS.UNAUTHORIZED}`,
      `POST ${PATHS.LOGIN}`,
      `GET ${PATHS.SERIAL}`,
      `GET ${PATHS.REGISTERS}`,
    ],
  );
  const login = srv.received[1];
  assert.equal(login.headers['content-type'], 'application/json');
  assert.match(
    login.headers['user-agent'],
    /^gladys-egauge\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-egauge\)$/,
  );
  // A wrong password: a refusal of the login.
  const wrong = new EgaugeClient({
    host: '127.0.0.1',
    port: srv.port,
    username: USERNAME,
    password: 'nope',
    checkPeer: () => {},
  });
  await assert.rejects(wrong.readSerial(), (err) => err.code === CODES.CREDENTIALS);
});
