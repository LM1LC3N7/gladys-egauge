# eGauge meter

**Unofficial** integration, not affiliated with eGauge Systems. It reads an
**eGauge energy meter** (EG4xxx, EG30xx with a firmware that offers the
WebAPI) through its **official WebAPI**, over HTTPS on your home network,
without any cloud. **Read-only**: the meter is never commanded nor
configured (the `/api/cmd` services — reboot, clear, factory restore — and
`/api/config` are never called).

**Never tested with a real eGauge meter**: built from the WebAPI
documentation (webapi.egauge.net) and the maker's egauge-python library
(MIT), and tested against a fake meter built from them.

## Requirements

- An eGauge meter on your network, reachable from Gladys over HTTPS (port 443
  by default);
- an account of the meter (Settings > Access Control in its web interface).
  An account that may only view the data is enough (without the "View
  settings" right, the meter is identified by its certificate, see
  "Identity"): create one for Gladys
  rather than giving the owner account.

## Configuration

- **Meter address**: its IP address (or local host name), with a port only
  if it is not 443. Give it a fixed address in your router.
- **User name** and **password** of the account. The password is kept by
  Gladys in its database, never shown again, and never leaves Gladys: the
  integration signs in with the digest login of the WebAPI (it proves it
  knows the password without sending it) and gets a token valid for about
  ten minutes. The user name, the password, the token and the serial number
  of the meter are never written to the logs, the status nor `/data`.
- **Certificate fingerprint** (optional): see below.
- **Registers counted as consumption** and **as production** (optional): the
  exact register names, separated by commas, whose energy goes into the
  Gladys energy monitoring. A register is in one list at most.

### The certificate

The meter shows a self-signed certificate, which no authority vouches for.
**Nothing is sent to the meter until you confirm its certificate**: at the
first read, the integration only makes the TLS handshake and shows the
SHA-256 fingerprint met in the status. Open `https://<meter address>` in your
browser, show the certificate and compare its SHA-256 fingerprint, then:

- click **Trust the certificate**: the first click reads the certificate
  again (a TLS handshake, nothing sent) and gives its fingerprint; the
  second, 3 seconds to 5 minutes later, trusts it if the meter still shows
  the same one; the fingerprint is kept in `/data`;
- or copy the fingerprint into the **Certificate fingerprint** field and
  save: it is then the one that counts.

If the certificate changes later (a meter replaced or reset), nothing is sent
any more and the status shows the new fingerprint: it is never learned again
by itself, you confirm it the same way. The check by an authority is off for
the requests to the meter only (the fingerprint decides instead), never for
the whole module.

Then open the **Discover** tab and create the registers you want.

## What you get

One device per register of a supported type, read every 30 seconds:

- **Power register** (type P: circuits, solar, grid):
  - not listed: its **power** (W, signed as the meter gives it, a plain
    sensor); for a register whose name ends with `+`, `-` or `|`, its
    **lifetime energy** (kWh, a plain sensor, not counted);
  - listed as consumption: **consumption power** (W) and **consumption
    index** (kWh); the Gladys energy monitoring derives the consumption per
    half hour from it (the 30-minute feature is declared with it, Gladys
    fills it);
  - listed as production: **production power** (W, the standby draw of an
    inverter at night shows as 0) and **production index** (kWh), with its
    production per half hour.
- **Voltage** (V), **current** (A), **frequency** (Hz) and **temperature**
  (°C) of the registers of those types.

A value outside the bounds declared to Gladys (a power beyond ±10 MW, a
temperature outside −100 to 1000 °C...) is no measure: it is not published.
A listed register that counts nothing (no power, or a lifetime energy at or
below 0) is said in the status.

Other types (humidity, flow, irradiance...) are not offered (the status
counts them).

### Which registers to list?

The meter accumulates each register in W·s. The suffix of a physical
register says what it accumulates: `+` the positive power only, `-` the
negative power only (shown here with the sign turned: what was exported),
`|` the absolute value; without a suffix, the **net** power, which may go up
and down. A net register not listed therefore has no energy in Gladys: a net
value that goes down is no counter.

Typically:

- as consumption, the total use of the home (the virtual register often
  named `use`) and, if you want to follow them, circuits;
- as production, the solar (`gen`, `Solar+`...);
- for the grid, prefer `Grid+` (bought) and `Grid-` (sold) registers created
  in the meter over the net `Grid`.

A value read is the meter's since the creation of its database (`raw`):
changing the "epoch" in the meter does not make it go down.

### Lifetime counters

Every lifetime energy (index or plain sensor) goes through a guard: never 0,
and an impossible **drop** or **jump** is never published by itself, nor
confirmed by time. The value is **held back** (the last good one stays), the
status shows it and the device gets an orange badge. If it is right (a meter
replaced, a register reset), click **Accept the held values** twice (3
seconds to 5 minutes apart): a jump accepted is counted at once, a drop
accepted counts nothing and the counter goes on from there. Saving the
configuration never accepts. A listed net register that goes down by
0.2 kWh at most (the standby draw of an inverter at night) is neither
published nor held: the last value stays until it rises again.

### Identity

At every read, the integration reads the serial number of the meter and
compares it with the one of the first read (a salted hash in `/data`, never
the number). An account without the "View settings" right may not read
that number: its registers are read all the same, and the meter is then
identified by the certificate you confirmed (the status says so); a new
certificate trusted then counts as "another meter" until your two clicks.
Another meter at the address: nothing is published until you
accept it (two clicks on **Accept the held values**), so that its counters
are never mixed with the first one's.

## Buttons

- **Test the connection**: reads the meter if a read is due (never more than
  one every 30 seconds), otherwise tells the last read. After a refused
  login, it tries once more.
- **Trust the certificate**: see above.
- **Accept the held values**: see above.

## What happens when...

- **The meter refuses the user name or the password**: nothing is read by
  itself until another one is saved or **Test the connection** succeeds. A
  read refused right after a successful login (the rights of the account) is
  not a refusal of the password.
- **The meter answers "too many requests" (429) or a 5xx error**: the reads
  pause, from 1 minute to 6 hours (or what the meter asks), kept across a
  restart.
- **The meter does not answer**: tried again after 30 seconds, doubled up to
  5 minutes.
- **The latest row of the meter is more than 2 hours old** (the meter's
  clock, its `Date` header): nothing is published.
- **`/data` cannot be read**: nothing is published nor offered (the meter
  cannot be identified), the button cannot trust a certificate (type the
  fingerprint), the file is never overwritten. **`/data` cannot be
  written**: the lifetime counters are held back, and nothing is published
  until the identity of the meter is kept there (first read).

Gladys takes at most 250 values a minute from the integration: with many
registers, the devices take turns.
