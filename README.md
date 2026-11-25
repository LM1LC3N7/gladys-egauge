# gladys-egauge

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for
**eGauge energy meters**, through their official local **WebAPI** (HTTPS on
your network, no cloud): the power of every register (circuits, solar,
grid), its voltage, current, frequency or temperature, and the energy of the
registers you choose for the Gladys energy monitoring. **Read-only**: the
meter is never commanded nor configured (`/api/cmd` and `/api/config` are
never called). Not affiliated with eGauge Systems.

**Never tested with a real eGauge meter**: built from the WebAPI
documentation and the maker's egauge-python library (MIT, see
`THIRD_PARTY_NOTICES.md`), and tested against a fake meter.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- The certificate of the meter is self-signed: nothing is sent until you
  confirm its fingerprint ("Trust the certificate", two clicks, or typed).
- The password never leaves Gladys (digest login of the WebAPI, then a
  token).
- Every lifetime counter goes through a guard: never 0, a drop or a jump
  held until you accept it.

## Development

```bash
npm install
npm test          # node --test (the fake meter runs on 127.0.0.1)
npm run lint
npm run format:check
```

See `CLAUDE.md` for the rules of the project and `TODO.md` for the decisions
and what is left to check on a real meter.

## License

Apache-2.0 (`LICENSE`), with the notices of `THIRD_PARTY_NOTICES.md`.
