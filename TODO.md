# TODO

## Before announcing

- [ ] Review r1 (xhigh).
- [ ] Test on a real Gladys with a real eGauge meter (none available): the
      certificate confirmed, the digest login, device creation, the
      consumption and production the core derives from the indexes.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic at publication only.

## To confirm on a real meter (built without one)

- [ ] The answer of `/api/auth/login` to a wrong password: taken as a refusal
      when it is HTTP 401/403 or a 200 with an `error` other than an expired
      nonce (egauge-python treats them so). HTTP 400 is a protocol error.
- [ ] `/api/register?raw&rate&virtual=value&time=now` on the firmwares met:
      one range, one row, the values in increasing register index (as the
      documentation and egauge-python say); `raw` with `virtual=value`.
- [ ] `/api/sys/sn` needs the `view_settings` right (WebAPI). Refused
      (401/403 right after a login, or a 200 with `error`, or no readable
      serial number, review r2): the registers are read all the same,
      the meter identified by the confirmed certificate (review r1, B1,
      option b); the serial number asked again at each new token only.
      To confirm: the status a real meter gives for that refusal.
- [ ] The register name suffixes (`+`, `-`, `|`) mean what they say for
      locally calculated registers only (WebAPI glossary); a remote register
      (Modbus...) ending with one may be net. Its lifetime energy is guarded
      anyway (a drop held).
- [ ] Whether the self-signed certificate changes at a firmware update (the
      user would confirm it again).
- [ ] The `rate` of `+` and `-` registers (taken signed as given, `-` turned).

## Later

- [ ] `keywords` in the manifest when the store accepts them (eGauge, energy
      monitor, solar, circuit).
- [ ] Other register types (humidity `h`, irradiance `Ee`, flow...) if asked.
- [ ] HTTP (no TLS) meters on old firmwares: not offered (HTTPS only).

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`).
- SDK `^0.16.1` (the latest published on 2026-11-25).
- Manifest: `categories: ["energy"]`, `gladys_version: ">=5.1.0"`, no
  `countries` (sold worldwide), no `keywords` yet.
- Reference: the eGauge WebAPI documentation (CDL-1.0) and egauge-python
  0.9.17 (MIT, eGauge Systems LLC): license read in the wheel; notice in
  `THIRD_PARTY_NOTICES.md`.
- The certificate is never pinned on first use: nothing is sent before the
  user confirms it (lot 25 brief: "empreinte confirmée par l'utilisateur").
  Two ways: the fingerprint typed, or "Trust the certificate" in two clicks,
  each click a TLS handshake that writes nothing, the second trusting only
  the same fingerprint. `rejectUnauthorized: false` only in the options of
  the requests to the meter, the fingerprint checked before any byte.
- Digest login only (the password never sent), even over HTTPS.
- Read-only: four paths, constants (`src/constants.js` `PATHS`); a test
  scans the sources for `/cmd` and `/config`.
- One device per register, id `reg-<did>-<kind>` (the database column, kept
  by a rename) or `virt-<16 hex of SHA-256(name)>-<kind>`: a type change is
  another device; a deleted register whose column is reused gets the same id
  (its counter then drops: held by the guard).
- Energy in the monitoring ONLY for the registers the user lists (as
  gladys-sunpower-pvs, which kept only the production index): the meter does
  not say which register is the home, the solar or the grid, and a net
  register (no suffix) goes down when the power flows back. Lists by exact
  name (commas: a register name never holds one); a name in both lists, or a
  wrong list: nothing counted, the status says it.
- Not listed: the power as a signed plain sensor; a lifetime energy only for
  `+`, `-`, `|` registers (monotonic by construction), plain sensor, kWh in
  the name, guarded. A net register not listed has no energy feature.
- A `-` register: index and power with the sign turned (the energy exported,
  positive).
- Production power floored at 0 (the core documents it >= 0): the standby
  draw of an inverter at night shows 0.
- A listed net register that drops by 0.2 kWh at most is neither published
  nor held (the last value stays); a larger drop goes to the guard. Outside
  `src/guard.js` (shared file, never changed alone).
- Guard limits: 1000 kW on average, 0.5 kWh slack (an eGauge may measure a
  building).
- Values from `raw` (counted from the creation of the database): a new
  epoch set in the meter never makes them drop.
- Identity: the serial number at every read (`/api/sys/sn`, one small
  request), a salted HMAC in /data; with it, an HMAC of the confirmed
  certificate. An account without `view_settings` (the read-only account the
  docs advise): the certificate is the identity (review r1, B1, decided by
  the coordinator: option b); a certificate trusted again then needs
  "Accept the held values".
- Values outside the bounds declared to Gladys (min/max of each feature,
  ENERGY_MAX for a counter) are not published (review r1, M4).
- Retries of an unreachable meter capped at 5 min (review r1, M7).
- Token used again for 8 minutes (the meter gives about 10).

## Next patch

- Review minors: see `_lots/lot25/reviews/egauge-r3.md` (m1 textes de l ancienne règle et statut noIdentity, m2 n° de série redemandé à chaque lecture sur 200+error).
