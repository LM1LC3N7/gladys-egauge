// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ACTIONS, PATHS, USER_AGENT } from '../src/constants.js';
import { CATALOG, buildDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const dockerfile = read('Dockerfile');
const strip = (code) => code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const sources = readdirSync(new URL('../src/', import.meta.url), { recursive: true })
  .map(String)
  .filter((name) => name.endsWith('.js'))
  .map((name) => `src/${name.replaceAll('\\', '/')}`);

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const fakeGladys = {
  externalIds: (type, id) => ({
    device: `ext:x:${type}:${id}`,
    feature: (key) => `ext:x:${type}:${id}:${key}`,
  }),
};

/** Every device of every kind, with every feature. */
const allDevices = () =>
  Object.entries(CATALOG).map(([kind, entries]) =>
    buildDevice(
      fakeGladys,
      { kind, platformId: `reg-1-${kind}`, name: 'R' },
      new Set(entries.map((e) => e.key)),
    ),
  );

test('the store basics; one semver version in 4 places, 0.1.0 set by hand', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-egauge:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.name, 'gladys-egauge');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^0\.16\.\d+$/);
  assert.deepEqual(manifest.categories, ['energy']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.ok(!('keywords' in manifest) && !('countries' in manifest), 'in TODO.md');
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-egauge\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
  // The User-Agent carries the version of the module.
  assert.ok(USER_AGENT.startsWith(`gladys-egauge/${pkg.version} `), USER_AGENT);
});

test('the cover is an 800 x 534 PNG', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('the docs say it was never tested with a real meter', () => {
  assert.match(read('docs/fr.md'), /[Jj]amais\s+testé\s+avec\s+un\s+vrai\s+compteur/);
  assert.match(read('docs/en.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+eGauge/);
  assert.match(read('README.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+eGauge/);
  assert.match(manifest.config_schema[0].description.en, /Never tested with a real eGauge meter/);
  assert.match(manifest.config_schema[0].description.fr, /Jamais testé avec un vrai compteur/);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) {
      assert.equal(typeof field.placeholder, 'object', `${field.key}.placeholder`);
    }
  }
});

test('the configuration matches the code; the password is a secret without default', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), [
    'intro',
    'address',
    'username',
    'password',
    'certificate_fingerprint',
    'consumption_registers',
    'production_registers',
  ]);
  for (const key of Object.keys(fields)) {
    assert.ok(!key.startsWith('gladys_'), `${key}: never prefixed gladys_`);
  }
  assert.equal(fields.address.required, true);
  assert.equal(fields.username.required, true);
  assert.equal(fields.password.type, 'secret');
  assert.equal(fields.password.required, true);
  assert.equal(fields.certificate_fingerprint.required, false);
  for (const field of manifest.config_schema.filter((f) => f.type === 'secret')) {
    assert.ok(!('default' in field), `${field.key}: never a default on a secret`);
  }
  assert.match(fields.password.description.en, /Kept by Gladys in its database, never shown again/);
  assert.match(fields.password.description.fr, /Gardé par Gladys dans sa base, jamais réaffiché/);
  // An example user name is not the id of anything.
  assert.notEqual(fields.username.placeholder.en, 'owner');
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
});

test('the actions of the manifest are the handlers of the code; read-only', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  for (const key of ['TEST', 'TRUST_CERTIFICATE', 'ACCEPT_HELD']) {
    assert.ok(index.includes(`onAction(ACTIONS.${key}`), key);
  }
  assert.ok(index.includes('onDeviceCreated'));
  assert.match(index, /\.connected\(\(\) => gladys\.getConfig\(\)\)/);
  assert.ok(!index.includes('onSetValue'), 'no command: read-only');
});

test('/api/cmd and /api/config are never called: every path is a constant of the allow list', () => {
  assert.deepEqual(Object.keys(PATHS).sort(), ['LOGIN', 'REGISTERS', 'SERIAL', 'UNAUTHORIZED']);
  for (const path of Object.values(PATHS)) {
    assert.match(path, /^\/api\/(auth\/(unauthorized|login)|sys\/sn|register\?)/);
  }
  for (const file of sources) {
    const code = strip(read(file));
    assert.doesNotMatch(code, /api\/(cmd|config)\b|['`"]\/(cmd|config)\b|'PUT'|'DELETE'/, file);
    // The authority check is off per request (the fingerprint decides), never for the process.
    assert.doesNotMatch(code, /NODE_TLS_REJECT_UNAUTHORIZED|globalAgent/, file);
    if (file !== 'src/egauge/http.js') assert.doesNotMatch(code, /rejectUnauthorized/, file);
  }
  const http = strip(read('src/egauge/http.js'));
  assert.ok(!http.includes('createConnection'), 'never a custom createConnection');
  assert.match(http, /agent: false/);
  const client = strip(read('src/egauge/client.js'));
  assert.ok(!client.includes('logger'), 'the client never logs');
  assert.match(client, /method: 'POST'/);
  assert.equal(client.match(/method: 'POST'/g).length, 1, 'one POST: the login');
});

test('the devices: core units only, nothing writable, no switch, indexes only for the lists', () => {
  const units = {
    'energy-production-sensor': ['watt', 'kilowatt-hour'],
    'energy-sensor': ['watt', 'kilowatt-hour', 'volt', 'ampere'],
    'temperature-sensor': ['celsius'],
    unknown: [undefined],
  };
  const indexes = [];
  for (const device of allDevices()) {
    for (const feature of device.features) {
      assert.ok(units[feature.category]?.includes(feature.unit), feature.external_id);
      assert.equal(feature.read_only, true);
      assert.notEqual(feature.category, 'switch');
      assert.notEqual(feature.type, 'binary');
      if (['index', 'energy'].includes(feature.type)) indexes.push(feature.external_id);
    }
  }
  assert.deepEqual(indexes.sort(), [
    'ext:x:egauge:reg-1-power:consumption_index',
    'ext:x:egauge:reg-1-power:production_index',
  ]);
});

test('supported_options of every published feature pass the rules of the core', () => {
  const core = new URL(
    '../../../Gladys/server/utils/normalizeSupportedOptions.js',
    import.meta.url,
  );
  let normalize;
  if (existsSync(core)) {
    try {
      normalize = createRequire(core)(core.pathname);
    } catch {
      normalize = undefined;
    }
  }
  let count = 0;
  for (const device of allDevices()) {
    for (const feature of device.features) {
      const options = feature.supported_options;
      if (options === undefined) continue;
      count += 1;
      const values = options.map((o) => `${o.value}`);
      assert.equal(new Set(values).size, values.length, 'unique values');
      for (const o of options) {
        assert.equal(typeof o.label, 'string');
        assert.ok(o.label.trim() !== '' && o.label === o.label.trim(), 'plain label');
        assert.deepEqual(Object.keys(o).sort(), ['label', 'value']);
      }
      if (typeof normalize === 'function') normalize(feature);
    }
  }
  // This integration publishes no select today: the rule holds for any added later.
  assert.equal(count, 0);
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /egauge-python/);
  assert.match(notices, /MIT License/);
  assert.match(notices, /Copyright \(c\) 2015-2023 eGauge Systems LLC/);
});

test('the code never feeds the energy consumption endpoint nor scene events', () => {
  for (const file of ['index.js', ...sources]) {
    assert.doesNotMatch(read(file), /publishEnergyConsumption\(/, file);
    assert.doesNotMatch(read(file), /publishSceneEvent\(/, file);
  }
});
