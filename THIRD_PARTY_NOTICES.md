# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below, distributed under its own
license. No code of it is shipped: the logic was rewritten in JavaScript.

## egauge-python (eGauge Systems LLC)

<https://bitbucket.org/egauge/python/>, by eGauge Systems LLC, the maker of
the eGauge meters. Version 0.9.17 (the wheel published on PyPI).

Ported to JavaScript in `src/egauge/client.js` and `src/egauge/model.js`: the
digest login of the WebAPI (`webapi/auth.py`, `JWTAuth`: the realm and the
server nonce of a 401, the client nonce, the hash
`MD5(MD5(usr:rlm:pwd):nnc:cnnc)`, an "expired nonce" answer tried again), the
`Authorization: Bearer` token, and the mapping of a row of `/api/register`
to its registers by increasing register index
(`webapi/device/register.py`). The WebAPI documentation
(<https://webapi.egauge.net>, Common Documentation License 1.0) was read as
the documentation of the API: the paths, the `raw`, `rate`, `virtual` and
`time` parameters, the type codes and their quanta, the register name
suffixes, the answers. Changed here: values read against strict patterns and
bounds (a value that is not a decimal integer is unknown, never 0), the
certificate checked against a fingerprint the user confirmed instead of
`verify=False`, one new nonce at most, never a write.

```
The MIT License (MIT)

Copyright (c) 2015-2023 eGauge Systems LLC

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## gladys-testkit

The certificates of `test/fixtures/certs` and the real-clock helpers of
`test/helpers/realclock.js` come from the shared test kit of these
integrations (Apache-2.0, same author): tests only, not in the image.
