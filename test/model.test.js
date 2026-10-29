// -----------------------------------------------------------------------------
// The pure part: the answers of the API (real captures) -> stations, points,
// high and low tides, values; the time zones and the summer time change.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, LEVEL_MAX, MAX_POINTS, OBSERVATION_STALE } from '../src/constants.js';
import {
  classifyExtremes,
  cleanText,
  freshObservation,
  interpolate,
  keysOf,
  localTime,
  minutesUntil,
  nextExtreme,
  parseMetadata,
  parsePoints,
  parseStation,
  parseStationList,
  parseTime,
  searchStations,
  timeZoneOf,
  valuesOf,
} from '../src/model.js';
import { fixture } from './helpers/fakes.js';
import { FIXTURE_NOW } from './helpers/iwls.js';

const DAY = 24 * 60 * 60_000;
const window = [FIXTURE_NOW - 2 * DAY, FIXTURE_NOW + 4 * DAY];

test('a station of the API: code, id, name, the three series used', () => {
  const [havre] = fixture('havre-station.json');
  const station = parseStation(havre);
  assert.equal(station.code, '90490');
  assert.equal(station.id, 'a0a0a0a0a0a0a0a0a0a09049');
  assert.equal(station.name, 'Havre-Fictif');
  assert.equal(station.province, 'NS');
  assert.equal(station.operating, true);
  assert.deepEqual(station.series, ['wlo', 'wlp', 'wlp-hilo']);
  // A hostile or broken entry is refused, never half used.
  assert.equal(parseStation({ ...havre, id: '../../admin' }), null);
  assert.equal(parseStation({ ...havre, code: '490' }), null);
  assert.equal(parseStation({ ...havre, code: '__proto__' }), null);
  assert.equal(parseStation(null), null);
  assert.equal(parseStation([]), null);
});

test('the station list: bounded, no duplicate, accents and other names searchable', () => {
  const list = parseStationList([
    ...fixture('stations-subset.json'),
    ...fixture('stations-subset.json'),
  ]);
  assert.equal(list.length, 8);
  assert.deepEqual(
    searchStations(list, 'saint joseph').map((s) => s.code),
    ['93057'],
  );
  assert.deepEqual(
    searchStations(list, 'Pointe aux exemples').map((s) => s.code),
    ['92985'],
  );
  // The alternative name of Bassin-Factice is "Leaf Pond".
  assert.deepEqual(
    searchStations(list, 'leaf pond').map((s) => s.code),
    ['94315'],
  );
  assert.deepEqual(searchStations(list, '  '), []);
  assert.deepEqual(parseStationList({ not: 'a list' }), []);
});

test('the metadata: time zone, status and notices in both languages', () => {
  const meta = parseMetadata(fixture('havre-metadata.json'));
  assert.equal(meta.timeZone, 'Canada/Atlantic');
  assert.equal(meta.status, 'OK');
  assert.match(meta.notice.en, /Invented notice of a fictional port authority/);
  assert.match(meta.notice.fr, /Avis inventé/);
  assert.ok(meta.notice.en.length <= 300);
  assert.match(meta.notice.en, /…$/);
  const unknown = parseMetadata({ timeZoneCode: 'Mars/Olympus', status: 'WHATEVER' });
  assert.equal(unknown.timeZone, null);
  assert.equal(unknown.status, null);
  assert.equal(timeZoneOf('America/Halifax'), 'America/Halifax');
  assert.equal(timeZoneOf('../etc/passwd'), null);
});

test('dates: UTC with Z or an offset only, nothing before 2000', () => {
  assert.equal(parseTime('2026-10-29T21:16:00Z'), Date.parse('2026-10-29T21:16:00Z'));
  assert.equal(parseTime('2026-10-29T18:16:00-03:00'), Date.parse('2026-10-29T21:16:00Z'));
  assert.ok(Number.isNaN(parseTime('2026-10-29T21:16:00')), 'no offset: refused');
  assert.ok(Number.isNaN(parseTime('1970-01-01T00:00:00Z')));
  assert.ok(Number.isNaN(parseTime(1761772560000)));
  assert.ok(Number.isNaN(parseTime('soon')));
});

test('points: inside the window asked, plausible, one per instant, sorted, bounded', () => {
  const from = Date.parse('2026-10-29T20:00:00Z');
  const to = Date.parse('2026-10-29T22:00:00Z');
  const points = parsePoints(
    [
      { eventDate: '2026-10-29T21:00:00Z', value: 3.1, qcFlagCode: '1' },
      { eventDate: '2026-10-29T20:30:00Z', value: 3.0, qcFlagCode: '2' },
      { eventDate: '2026-10-29T21:00:00Z', value: 9.9, qcFlagCode: '1' }, // duplicate
      { eventDate: '2026-10-29T19:00:00Z', value: 3.0 }, // before the window
      { eventDate: '2026-10-29T21:10:00Z', value: '3.2' }, // a string is not a number
      { eventDate: '2026-10-29T21:20:00Z', value: LEVEL_MAX + 1 }, // implausible
      { eventDate: '2026-10-29T21:30:00Z', value: null }, // missing: never a 0
      { eventDate: '2026-10-29T21:40:00Z', value: 0, qcFlagCode: '3' }, // a real 0 is kept
      null,
      'x',
    ],
    from,
    to,
  );
  assert.deepEqual(
    points.map((p) => [new Date(p.t).toISOString().slice(11, 16), p.v, p.qc]),
    [
      ['20:30', 3.0, 2],
      ['21:00', 3.1, 1],
      ['21:40', 0, 3],
    ],
  );
  const many = Array.from({ length: MAX_POINTS + 50 }, (_, i) => ({
    eventDate: new Date(from + i * 1000).toISOString(),
    value: 1,
  }));
  assert.equal(parsePoints(many, from, to).length, MAX_POINTS);
});

test('the curve: linear between two points, nothing outside or across a gap', () => {
  const curve = parsePoints(fixture('baie-wlp.json'), ...window);
  assert.equal(curve.length, 205);
  const t = Date.parse('2026-10-29T21:07:30Z');
  const a = curve.find((p) => p.t === Date.parse('2026-10-29T21:00:00Z')).v;
  const b = curve.find((p) => p.t === Date.parse('2026-10-29T21:15:00Z')).v;
  assert.ok(Math.abs(interpolate(curve, t) - (a + b) / 2) < 1e-9);
  assert.equal(interpolate(curve, curve[0].t - 1), null);
  assert.equal(interpolate(curve, curve.at(-1).t + 1), null);
  assert.equal(interpolate([], t), null);
  const gap = [
    { t: 0, v: 1 },
    { t: 3 * 60 * 60_000, v: 2 },
  ];
  assert.equal(interpolate(gap, 60 * 60_000), null);
  assert.equal(interpolate(gap, 0), 1);
});

test('high and low tides of Havre-Fictif: they alternate, each told by its neighbours', () => {
  const curve = parsePoints(fixture('havre-wlp.json'), ...window);
  const extremes = classifyExtremes(parsePoints(fixture('havre-hilo.json'), ...window), curve);
  assert.equal(extremes.length, 14, 'every tide classified, none guessed away');
  for (let i = 1; i < extremes.length; i += 1) {
    assert.notEqual(extremes[i].kind, extremes[i - 1].kind, `tides ${i - 1} and ${i} alternate`);
  }
  for (const e of extremes) {
    assert.ok(e.kind === 'high' ? e.v > 1.2 : e.v < 0.8, `${new Date(e.t).toISOString()} ${e.v}`);
  }
  // The real next high tide after the capture: 02:25 UTC, 1.68 m.
  const high = nextExtreme(extremes, 'high', FIXTURE_NOW);
  assert.equal(new Date(high.t).toISOString(), '2026-10-30T02:25:00.000Z');
  assert.equal(high.v, 1.68);
});

test('a lone tide without the curve is left out rather than guessed', () => {
  const lone = [{ t: FIXTURE_NOW, v: 1, qc: 1 }];
  assert.deepEqual(classifyExtremes(lone, []), []);
  // Neighbours that disagree (a rising run) and no curve: left out.
  const run = [0, 1, 2].map((i) => ({ t: FIXTURE_NOW + i * 6 * 60 * 60_000, v: i }));
  assert.deepEqual(
    classifyExtremes(run, []).map((e) => e.kind),
    ['low', 'high'],
    'the ends compare with their one neighbour; the middle of a run is not a tide',
  );
});

test('time zones: station time with its abbreviation, across the end of summer time', () => {
  // Atlantic time: ADT (UTC-3) until 2026-11-01 05:00 UTC, then AST (UTC-4).
  assert.equal(
    localTime(Date.parse('2026-11-01T04:30:00Z'), 'Canada/Atlantic'),
    '2026-11-01 01:30 ADT',
  );
  assert.equal(
    localTime(Date.parse('2026-11-01T05:30:00Z'), 'Canada/Atlantic'),
    '2026-11-01 01:30 AST',
  );
  // Newfoundland: half an hour.
  assert.equal(
    localTime(Date.parse('2026-10-29T21:16:00Z'), 'Canada/Newfoundland'),
    '2026-10-29 18:46 NDT',
  );
  // Pacific, the day before in local time at 01:00 UTC.
  assert.equal(
    localTime(Date.parse('2026-10-30T01:00:00Z'), 'Canada/Pacific'),
    '2026-10-29 18:00 PDT',
  );
  // East of UTC, a midnight crossing too (a station of the API never is, but the code does not care).
  assert.equal(
    localTime(Date.parse('2026-10-29T23:30:00Z'), 'Europe/Paris'),
    '2026-10-30 00:30 GMT+1',
  );
  // Without a known zone: UTC, said.
  assert.equal(localTime(Date.parse('2026-10-29T21:16:00Z'), null), '2026-10-29 21:16 UTC');
  assert.equal(
    localTime(Date.parse('2026-10-29T21:16:00Z'), 'Mars/Olympus'),
    '2026-10-29 21:16 UTC',
  );
});

test('countdowns: rounded up, 0 at the tide, never negative', () => {
  assert.equal(minutesUntil(FIXTURE_NOW + 30_000, FIXTURE_NOW), 1);
  assert.equal(minutesUntil(FIXTURE_NOW + 60_000, FIXTURE_NOW), 1);
  assert.equal(minutesUntil(FIXTURE_NOW + 60_001, FIXTURE_NOW), 2);
  assert.equal(minutesUntil(FIXTURE_NOW, FIXTURE_NOW), 0);
  assert.equal(minutesUntil(FIXTURE_NOW - 5000, FIXTURE_NOW), 0);
});

test('observations: published while recent and not questionable', () => {
  const obs = { t: FIXTURE_NOW - 60_000, v: 3.1, qc: 1 };
  assert.equal(freshObservation(obs, FIXTURE_NOW), obs);
  assert.equal(freshObservation({ ...obs, qc: 3 }, FIXTURE_NOW), null);
  assert.equal(
    freshObservation({ ...obs, t: FIXTURE_NOW - OBSERVATION_STALE - 1 }, FIXTURE_NOW),
    null,
  );
  assert.equal(freshObservation({ ...obs, t: FIXTURE_NOW + 60 * 60_000 }, FIXTURE_NOW), null);
  assert.equal(freshObservation(null, FIXTURE_NOW), null);
});

test('values: only what is known; a silent gauge publishes nothing, never a 0', () => {
  const station = {
    ...parseStation(fixture('havre-station.json')[0]),
    timeZone: 'Canada/Atlantic',
  };
  const curve = parsePoints(fixture('havre-wlp.json'), ...window);
  const extremes = classifyExtremes(parsePoints(fixture('havre-hilo.json'), ...window), curve);
  const values = valuesOf(station, { curve, extremes, obs: null }, FIXTURE_NOW);
  assert.equal(values.has(FEATURES.OBSERVED), false);
  assert.equal(values.has(FEATURES.SURGE), false);
  assert.equal(values.has(FEATURES.OBSERVED_AT), false);
  assert.deepEqual(values.get(FEATURES.NEXT_HIGH_TIME), { text: '2026-10-29 23:25 ADT' });
  assert.deepEqual(values.get(FEATURES.NEXT_HIGH_HEIGHT), { state: 1.68 });
  assert.equal(values.get(FEATURES.NEXT_HIGH_MINUTES).state, 309);
  // Nothing at all: no value.
  assert.equal(valuesOf(station, { curve: [], extremes: [], obs: null }, FIXTURE_NOW).size, 0);
  // Every published text is a text, every number a number.
  for (const value of values.values()) {
    assert.ok(
      ('text' in value && typeof value.text === 'string' && value.text.length > 0) ||
        Number.isFinite(value.state),
    );
  }
  // The keys a station has follow its series.
  assert.equal(keysOf({ series: ['wlp', 'wlp-hilo'] }).has(FEATURES.OBSERVED), false);
  assert.equal(keysOf({ series: ['wlo'] }).has(FEATURES.SURGE), false);
  assert.equal(keysOf({ series: ['wlo', 'wlp'] }).has(FEATURES.SURGE), true);
});

test('texts from the network are cleaned and bounded', () => {
  assert.equal(cleanText('Halifax\u0000\u001b[31m\n  Harbour\u0085'), 'Halifax[31m Harbour');
  assert.equal(cleanText('x'.repeat(500)).length, 80);
  assert.equal(cleanText(42), '');
});
