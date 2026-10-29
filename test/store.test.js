// -----------------------------------------------------------------------------
// The persisted state: a round trip, and a hostile or broken file that is
// checked, never trusted, never overwritten when it cannot be read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITED_MAX } from '../src/constants.js';
import { CorruptStateError, emptyState, fileStorage, loadState, saveState } from '../src/store.js';
import { FIXTURE_NOW, BAIE } from './helpers/iwls.js';

const station = {
  code: '97120',
  id: BAIE.id,
  name: 'Baie-Imaginaire',
  alternative: '',
  province: 'BC',
  operating: true,
  series: ['wlo', 'wlp', 'wlp-hilo'],
  timeZone: 'Canada/Pacific',
  status: 'OK',
  notice: { en: '', fr: '' },
};

function sample() {
  const state = emptyState();
  state.pause = { until: FIXTURE_NOW + 60_000, streak: 2 };
  state.stations.set('97120', station);
  state.data.set('97120', {
    extremes: [
      { t: FIXTURE_NOW + 3_960_000, v: 2.95, kind: 'high' },
      { t: FIXTURE_NOW + 36_000_000, v: 0.49, kind: 'low' },
    ],
    curve: [
      { t: FIXTURE_NOW, v: 2.8 },
      { t: FIXTURE_NOW + 900_000, v: 2.9 },
    ],
    predAt: FIXTURE_NOW,
    obs: { t: FIXTURE_NOW - 30_000, v: 3.1, qc: 1 },
    noCurve: false,
    unclassified: 1,
  });
  state.tries.set('obs:97120', {
    at: FIXTURE_NOW,
    mono: 5,
    ok: true,
    unknown: false,
    fails: 3,
    idSuspect: true,
  });
  state.known.set('97120', new Set(['observed-level', 'next-high-time']));
  state.fired.set('97120|high|60', FIXTURE_NOW);
  state.pending.push({
    key: 'tide_coming',
    data: { device: 'ext:x:station:97120', kind: 'high', lead: '60', height: 2.9 },
    at: FIXTURE_NOW,
    tideAt: FIXTURE_NOW + 3_600_000,
  });
  return state;
}

test('a round trip through JSON keeps everything (the monotonic instant excepted)', () => {
  const back = loadState(JSON.parse(JSON.stringify(saveState(sample()))), FIXTURE_NOW);
  assert.deepEqual(back.stations.get('97120'), station);
  assert.deepEqual(back.data.get('97120'), sample().data.get('97120'));
  assert.deepEqual(back.tries.get('obs:97120'), {
    at: FIXTURE_NOW,
    mono: null,
    ok: true,
    unknown: false,
    fails: 3,
    idSuspect: true,
    recheck: false,
  });
  assert.deepEqual([...back.known.get('97120')], ['observed-level', 'next-high-time']);
  assert.equal(back.fired.get('97120|high|60'), FIXTURE_NOW);
  assert.equal(back.pending[0].data.lead, '60');
  assert.equal(back.pending[0].data.summary, null);
  assert.equal(back.pending[0].tideAt, FIXTURE_NOW + 3_600_000);
  assert.deepEqual(back.pause, { until: FIXTURE_NOW + 60_000, streak: 2 });
});

test('a hostile file: bad codes, ids, keys, numbers and dates are dropped', () => {
  const raw = JSON.parse(JSON.stringify(saveState(sample())));
  raw.stations.push(
    ['__proto__', { ...station, id: 'x' }],
    ['90490', { ...station, id: '../../x' }],
  );
  raw.stations.push(['490', station]);
  raw.data[0][1].curve.push({ t: 'soon', v: 1 }, { t: FIXTURE_NOW + 10, v: 1e9 });
  raw.data[0][1].extremes.push({ t: FIXTURE_NOW + 4e7, v: 1, kind: 'flood' });
  raw.tries.push(['constructor', { at: FIXTURE_NOW }], ['obs:90490', { at: FIXTURE_NOW + 1e9 }]);
  raw.known.push(['97120', ['predicted-level', 'admin']]);
  raw.fired.push(['97120|high|45', FIXTURE_NOW], ['97120|high|60|x', FIXTURE_NOW]);
  raw.pending.push({ key: 'other', data: {}, at: FIXTURE_NOW, tideAt: FIXTURE_NOW });
  raw.pending.push({ key: 'tide_coming', data: {}, at: FIXTURE_NOW });
  raw.data[0][1].unclassified = 1e9;
  raw.tries[0][1].fails = 1e9;
  raw.pause = { until: FIXTURE_NOW + 100 * LIMITED_MAX, streak: 1e9 };
  const state = loadState(raw, FIXTURE_NOW);
  assert.deepEqual([...state.stations.keys()], ['97120']);
  assert.equal(state.data.get('97120').curve.length, 2);
  assert.equal(state.data.get('97120').extremes.length, 2);
  assert.deepEqual([...state.tries.keys()], ['obs:97120', 'obs:90490']);
  // A try dated ahead of the clock is taken as "now": never a shorter wait.
  assert.equal(state.tries.get('obs:90490').at, FIXTURE_NOW);
  assert.deepEqual([...state.known.get('97120')], ['predicted-level']);
  assert.deepEqual([...state.fired.keys()], ['97120|high|60']);
  assert.equal(state.pending.length, 1, 'no foreign key, no event without its tide');
  assert.equal(state.data.get('97120').unclassified, 40);
  assert.equal(state.tries.get('obs:97120').fails, 20);
  assert.equal(state.pause.until, FIXTURE_NOW + LIMITED_MAX);
  assert.equal(state.pause.streak, 10);
  assert.equal(Object.prototype.polluted, undefined);
  for (const value of [null, 'text', 42, [], { stations: 'x', data: {} }]) {
    assert.deepEqual(saveState(loadState(value, FIXTURE_NOW)), saveState(emptyState()));
  }
});

test('the file: written atomically, a missing file is a first start, a broken one throws', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'marees-canada-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'sub', 'state.json');
  const storage = fileStorage(path);
  assert.equal(await storage.load(), undefined);
  // A stale .tmp left by a crash is never written through.
  await mkdir(join(dir, 'sub'), { recursive: true });
  await writeFile(`${path}.tmp`, 'stale');
  await storage.save(saveState(sample()));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).v, 1);
  await assert.rejects(stat(`${path}.tmp`), { code: 'ENOENT' }, 'renamed, not copied');
  assert.equal(loadState(await storage.load(), FIXTURE_NOW).stations.size, 1);
  await writeFile(path, '{"v":1,');
  await assert.rejects(storage.load(), CorruptStateError);
  await storage.quarantine();
  assert.equal(await readFile(`${path}.bad`, 'utf8'), '{"v":1,');
  assert.equal(await storage.load(), undefined);
  await writeFile(path, '');
  await assert.rejects(storage.load(), /corrupt/);
  // A directory (or a FIFO) in its place: unreadable, not missing, not corrupt.
  await rm(path);
  await mkdir(path);
  await assert.rejects(
    storage.load(),
    (err) => !(err instanceof CorruptStateError) && /unreadable/.test(err.message),
  );
});
