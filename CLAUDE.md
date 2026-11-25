# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
Its only runtime dependency is the SDK. It started from the official
JavaScript template.

It reads an **eGauge energy meter** through its official local **WebAPI**
(HTTPS, webapi.egauge.net): the digest login (`/api/auth/unauthorized`,
`/api/auth/login`), then `/api/sys/sn` and `/api/register` with the JWT.
Logic ported from egauge-python (MIT, eGauge Systems LLC), see
`THIRD_PARTY_NOTICES.md`. Unofficial. Sibling: `gladys-sunpower-pvs`
(structure, app, store, guard, HTTPS transport).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "trust"   # tests whose name matches
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
node scripts/cover.mjs cover.png          # the store cover (800×534)
```

## Architecture

```
index.js                     SDK wiring only: handlers registered before connect()
src/app.js                   EgaugeApp: getConfig retries, the pace, the certificate, the identity, the guards, /data, buttons
src/egauge/http.js           the only network access (HTTPS, fingerprint checked before any byte, bounded; the TLS probe)
src/egauge/client.js         the WebAPI: digest login, token, /api/sys/sn, /api/register
src/egauge/model.js          the answers -> values, strict (pure)
src/egauge/errors.js         our error codes (messages safe to log)
src/guard.js                 plausibility of a lifetime counter (shared file, pure)
src/store.js                 what /data keeps across restarts (unreadable is not empty)
src/devices.js               the devices, feature keys, external ids, states (pure)
src/config.js                the address, the account, the fingerprint, the lists, normalized
src/constants.js             paths, pacing, limits, manifest keys
src/i18n.js                  runtime texts (en/fr)
scripts/cover.mjs            the cover image
test/fixtures/meter.js       the fake meter (transport level)
test/helpers/server.js       the fake meter behind a real HTTPS server; a TLS impostor
```

## Rules

- **Read-only**: only the four `PATHS` of `src/constants.js`; `/api/cmd` and
  `/api/config` are never called (a test scans the sources). One POST: the
  login.
- **Certificate**: nothing is written to the meter before its certificate
  is the fingerprint typed or the one the user trusted ("Trust the
  certificate", two clicks, each a handshake that writes nothing). Never
  learned on first use, never learned again by itself.
  `rejectUnauthorized: false` only in the options of a request to the meter.
- **Secrets**: the user name, the password and the token live in private
  fields of `EgaugeClient`; the password is never sent (digest). Never in a
  log, an error, a status, /data, an id or a name. The serial number is kept
  as a salted HMAC only. Never the forbidden word for secrets
  (`test/encoding.test.js`).
- **Energy**: indexes (`energy-sensor` / `index`,
  `energy-production-sensor` / `index`, with their 30-minute features
  declared, UUID v5 ids) only for the registers the user lists. Every
  lifetime counter passes `IndexGuard` (`src/guard.js`) on the session
  clock: never 0, a drop and a jump never confirmed by time, taken only by
  `accept_held` in two clicks. Do not change `src/guard.js` without the same
  change in its siblings and a review.
- **Units**: only the core's (`DEVICE_FEATURE_UNITS_BY_CATEGORY`).
- **Strict values**: a cumulative value is a decimal integer string (BigInt,
  64 bits), anything else is unknown, never 0.
- **The pace**: never two reads less than 30 s apart, whatever asks; the
  time of the last read is in /data before the request.
- **Identity**: the serial number of every read against /data; another one:
  nothing published until `accept_held`; unreadable: nothing published from
  that read.
- **Freshness**: a row is published once (its time in /data), never when it
  is more than 2 h older than the Date header of the meter.
- **Late answers**: every await in a read is followed by `gone()`.
- **`/data`**: an unreadable file is not an empty state: never overwritten,
  no counter published; a save that fails holds the counters back.
- **getConfig** in `connected` is retried without end (5 s doubled to 5 min).
- **At most 250 states a minute** (`budget`).
- **External ids are forever**: `reg-<did>-<kind>`, `virt-<hash>-<kind>`,
  the `FEATURE` keys of `src/devices.js`, the manifest keys and actions.
  Features only grow.
- **The container rootfs is read-only.** Write only `/data/egauge-state.json`.
- **Versions belong to the Release workflow** (Actions → Release), except the
  first 0.1.0 set by hand. `test/manifest.test.js` checks they agree; the
  User-Agent carries the version too.
- **Changelog**: every user-visible change under `## [Unreleased]`.
- **Manifest**: texts `{ en, fr }`; never a `default` on a secret.
- **Style**: Prettier, ESLint; comments explain why, in English. Tests never
  touch the network (the HTTPS tests use 127.0.0.1); `mkdtemp` folders are
  removed in `t.after`.

## CI and pushes

- Group the commits and push **at most once a day**, unless the maintainer
  explicitly asks otherwise: the GitHub Actions quota is limited.
- If every CI job fails in under 2 seconds, the quota is exhausted: it is not
  a bug in the code.
