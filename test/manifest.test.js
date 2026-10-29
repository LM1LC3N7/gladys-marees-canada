// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. They also guard
// the text files against mojibake, a BOM and control bytes.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  ACTIONS,
  KINDS,
  LEADS,
  MAX_POLL_MINUTES,
  MIN_POLL_MINUTES,
  SCENE_TRIGGERS,
} from '../src/constants.js';
import { FEATURE_DEFS, deviceOf } from '../src/model.js';
import { tideEvents } from '../src/triggers.js';

const readBuffer = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const read = (path) => readBuffer(path).toString('utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');

// The core's own validator of supported_options, when a Gladys clone is at
// hand (not on GitHub CI): the rules below are its schema, this is the proof.
const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

const TEXT_FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'TODO.md',
  'CLAUDE.md',
  'THIRD_PARTY_NOTICES.md',
  'index.js',
  ...readdirSync(new URL('../src/', import.meta.url)).map((name) => `src/${name}`),
  ...readdirSync(new URL('../test/fixtures/', import.meta.url)).map((n) => `test/fixtures/${n}`),
];

test('no mojibake, no BOM, no control byte in the texts', () => {
  assert.ok(TEXT_FILES.length > 20, 'every source file is checked');
  for (const file of TEXT_FILES) {
    const buffer = readBuffer(file);
    assert.ok(
      !(buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf),
      `${file} starts with a BOM`,
    );
    const text = buffer.toString('utf8');
    assert.ok(!text.includes('\ufffd'), `${file} holds an invalid UTF-8 sequence`);
    for (const bad of ['Ã', 'Â', 'â€']) {
      assert.ok(!text.includes(bad), `${file} holds mojibake (${bad})`);
    }
    // Control characters: only tab, line feed (and a carriage return never).
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f]/, `${file} holds a control byte`);
    // Combining marks only as \u escapes (a regex class of them is invisible).
    assert.doesNotMatch(text, /[\u0300-\u036f]/, `${file} holds a bare combining mark`);
  }
  // The French texts really hold their accents.
  assert.match(read('docs/fr.md'), /é/);
  assert.match(manifest.config_schema[0].description.fr, /prédit/);
});

test('never "chiffré" nor "encrypted": nothing here is a secret anyway', () => {
  for (const file of TEXT_FILES) {
    assert.doesNotMatch(read(file), /chiffré|chiffrement|encrypt|hachage/i, file);
  }
  assert.ok(!manifest.config_schema.some((f) => f.type === 'secret' || f.type === 'password'));
});

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.deepEqual(manifest.categories, ['environment']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /IWLS/);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /non officiel/);
  // Not for navigation: said first, in the intro and at the top of the docs.
  assert.match(manifest.config_schema[0].description.en, /^Not for navigation/);
  assert.match(manifest.config_schema[0].description.fr, /^Pas pour la navigation/);
  assert.match(
    read('docs/en.md').split('\n').slice(0, 6).join(' '),
    /not to be used for navigation/i,
  );
  assert.match(read('docs/fr.md').split('\n').slice(0, 6).join(' '), /pas pour la navigation/i);
  // Using it means accepting the CHS licence: said in the intro and the docs.
  assert.match(manifest.config_schema[0].description.en, /accepting the CHS licence agreement/);
  assert.match(
    manifest.config_schema[0].description.fr,
    /acceptation de l'accord de licence du SHC/,
  );
  assert.ok(manifest.config_schema[0].links.some((l) => /licence-agreement/.test(l.url)));
  assert.match(read('docs/en.md'), /within 15 days/);
  assert.match(read('docs/fr.md'), /sous 15 jours/);
  // The notice the licence of the CHS asks for, in full, in the docs and the README.
  for (const file of ['docs/en.md', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
    assert.match(
      read(file),
      /This product is not to be used for navigation\. This product was made by or for/,
    );
    assert.match(
      read(file),
      /does not constitute an endorsement or an approval of this product by the Canadian Hydrographic Service/,
    );
  }
  assert.match(
    read('docs/en.md'),
    /never[\s>]+been[\s>]+run[\s>]+by[\s>]+a[\s>]+Gladys[\s>]+installation/i,
  );
  assert.match(
    read('docs/fr.md'),
    /jamais[\s>]+été[\s>]+lancé[\s>]+par[\s>]+une[\s>]+installation[\s>]+Gladys/i,
  );
});

test('version 0.1.0 everywhere, and the image is tagged with it', () => {
  assert.match(pkg.version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  assert.equal(pkg.version, '0.1.0');
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-marees-canada:${manifest.version}`);
  // The SDK is a range, never a pinned version.
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^/);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
});

test('the license and the notices ship with the image, without any name in LICENSE', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'the bare template');
  assert.doesNotMatch(license, /Louis|lmilcent|LM1LC3N7|Milcent/i);
  assert.equal(pkg.license, 'Apache-2.0');
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /Canadian Hydrographic Service/);
  assert.match(notices, /test\/fixtures/);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY .*LICENSE/);
  assert.match(dockerfile, /COPY .*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('sections are purely presentational, with https links', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang} is too long`);
    }
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//);
    }
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.equal(fields[key]?.default, value, key);
  }
  for (const field of manifest.config_schema) {
    assert.ok(!field.key.startsWith('gladys_'), field.key);
    if (field.default !== undefined) {
      assert.equal(DEFAULT_CONFIG[field.key], field.default, field.key);
    }
  }
  assert.equal(fields.poll_interval.min, MIN_POLL_MINUTES);
  assert.equal(fields.poll_interval.max, MAX_POLL_MINUTES);
  // An example is never the id of the field.
  assert.notEqual(fields.stations.placeholder.en, 'stations');
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(index.includes('onAction(ACTIONS.SEARCH'));
  for (const action of manifest.actions) {
    assert.ok(action.timeout_seconds <= 120);
  }
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
});

test('the tide trigger: its filters and variables are what the events carry', () => {
  const [trigger] = manifest.scene_triggers;
  assert.deepEqual(
    trigger.fields.find((f) => f.key === 'kind').options.map((o) => o.value),
    Object.values(KINDS),
  );
  assert.deepEqual(
    trigger.fields.find((f) => f.key === 'lead').options.map((o) => o.value),
    LEADS.map(String),
  );
  assert.equal(trigger.fields.find((f) => f.key === 'device').source, 'devices');
  // Required: a scene without a station would fire for every station.
  for (const key of ['device', 'kind', 'lead']) {
    assert.equal(trigger.fields.find((f) => f.key === key).required, true, key);
  }
  const tide = { t: Date.parse('2026-10-29T22:22:00Z'), v: 2.95, kind: 'high' };
  const [event] = tideEvents({
    station: { code: '97120', name: 'Baie-Imaginaire', timeZone: 'Canada/Pacific' },
    extremes: [tide],
    now: tide.t,
    fired: new Map(),
    device: 'ext:marees-canada:station:97120',
  });
  const declared = [...trigger.fields, ...trigger.variables].map((d) => d.key);
  assert.deepEqual(Object.keys(event.data).sort(), declared.sort());
  assert.ok(Object.keys(event.data).length <= 30);
  for (const value of Object.values(event.data)) {
    assert.ok(
      value === null ||
        typeof value === 'string' ||
        (typeof value === 'number' && Number.isFinite(value)),
    );
  }
});

// DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js (Gladys core),
// for the categories this integration uses; `text` has no unit.
const CORE_UNITS = {
  'level-sensor': ['mm', 'cm', 'm', 'km', 'inch', 'feet', 'mile', 'percent'],
  duration: [
    'microseconds',
    'milliseconds',
    'seconds',
    'minutes',
    'hours',
    'days',
    'weeks',
    'months',
    'years',
  ],
  text: [],
};

test('every feature uses a unit the core lists for its category, read only, never a switch', () => {
  const gladys = createFakeGladys({ selector: 'marees-canada' });
  const device = deviceOf(
    gladys,
    { code: '97120', name: 'Baie-Imaginaire' },
    new Set(FEATURE_DEFS.keys()),
  );
  assert.equal(device.features.length, FEATURE_DEFS.size);
  for (const feature of device.features) {
    assert.ok(feature.category in CORE_UNITS, `${feature.category} is not checked`);
    const allowed = CORE_UNITS[feature.category];
    if (allowed.length === 0) {
      assert.equal(feature.unit, undefined, feature.external_id);
    } else {
      assert.ok(allowed.includes(feature.unit), `${feature.external_id}: ${feature.unit}`);
    }
    assert.ok(!['switch', 'binary'].includes(feature.category));
    assert.notEqual(feature.type, 'binary');
    assert.equal(feature.read_only, true);
  }
});

test('the supported_options of every feature follow the rules of the core', () => {
  const gladys = createFakeGladys({ selector: 'marees-canada' });
  const device = deviceOf(gladys, { code: '97120', name: 'V' }, new Set(FEATURE_DEFS.keys()));
  for (const feature of device.features) {
    const options = feature.supported_options;
    if (options === undefined) {
      continue;
    }
    // The rules of the core (one error rejects the whole Discovery list).
    assert.ok(Array.isArray(options) && options.length > 0);
    const values = new Set();
    for (const option of options) {
      assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
      assert.equal(typeof option.label, 'string');
      assert.ok(option.label.length > 0 && option.label === option.label.trim());
      assert.ok(typeof option.value === 'string' || Number.isInteger(option.value));
      assert.ok(!values.has(option.value));
      values.add(option.value);
    }
    if (normalizeSupportedOptions) {
      assert.doesNotThrow(() => normalizeSupportedOptions(options, feature));
    }
  }
  // None is published today: a select would need these checks first.
  assert.ok(device.features.every((f) => f.supported_options === undefined));
});
