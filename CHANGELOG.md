# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- eGauge energy meters through the official local WebAPI (HTTPS): one device
  per register of type power, voltage, current, frequency or temperature,
  read every 30 seconds.
- Registers listed by the user counted by the Gladys energy monitoring as
  consumption or production (index with its 30-minute feature); `+`, `-` and
  `|` registers get a plain lifetime energy; every lifetime counter guarded
  (never 0, drops and jumps held until accepted in two clicks).
- The self-signed certificate confirmed by the user before anything is sent
  ("Trust the certificate" in two clicks, or the fingerprint typed); a
  changed certificate is never learned again by itself.
- The digest login of the WebAPI: the password never leaves Gladys.
- The identity of the meter (its serial number, a salted hash in `/data`)
  checked at every read.
- Read-only: `/api/cmd` and `/api/config` are never called.
