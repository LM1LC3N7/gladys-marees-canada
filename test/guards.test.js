// -----------------------------------------------------------------------------
// The guards the review r1 found unprotected (mutation survivors), and the
// corrections of r1: late tide events dated from their due instant, recovery
// after a failure at the first read, /data frozen or corrupt, stations without
// a curve, unclassified tides, the predicted level every 15 minutes. One test
// per guard: removing the guard fails it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IwlsClient } from '../src/client.js';
import {
  CONFIG_RETRY_MIN,
  EVENT_LATE_MAX,
  FEATURES,
  HEARTBEAT,
  MAX_EXTREMES,
  MAX_LIST_ENTRIES,
  MAX_PENDING_EVENTS,
  PREDICTION_RETRY,
  REQUEST_GAP,
  STORE_TIMEOUT,
  TICK,
} from '../src/constants.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyExtremes,
  curveStep,
  formatCacheSize,
  localTime,
  parseStation,
  parseStationList,
  searchStations,
} from '../src/model.js';
import {
  CorruptStateError,
  emptyState,
  fileStorage,
  loadState,
  memoryStorage,
  saveState,
} from '../src/store.js';
import { tideEvents } from '../src/triggers.js';
import { testClock } from './kit/index.mjs';
import { installFetch, json } from './helpers/fakes.js';
import {
  BAIE,
  FIXTURE_NOW,
  HAVRE,
  createAll,
  drain,
  iwlsService,
  lastValue,
  setup,
} from './helpers/iwls.js';

const MIN = 60_000;
const H = 60 * MIN;

async function ready(t, options = {}) {
  const env = await setup(t, options);
  await env.app.start(options.config ?? { stations: '90490, 97120' });
  await drain(env.app, env.clock);
  await createAll(env.gladys);
  await env.app.fastLoop(env.app.generation, { force: true });
  return env;
}

const sent = (gladys) => gladys.fake.sceneEvents.map((e) => e.data ?? e);

// --- Tide events (I2) -----------------------------------------------------------------

test('a tide event is dated from its due instant: dropped 10 minutes after it, never later', async (t) => {
  const { app, clock, gladys } = await ready(t, { config: { stations: '97120' } });
  const real = gladys.publishSceneEvent.bind(gladys);
  let down = true;
  gladys.publishSceneEvent = async (...args) => {
    if (down) {
      throw Object.assign(new Error('gladys restarting'), { status: 503 });
    }
    return real(...args);
  };
  // High tide at 22:22 UTC, lead 60 due at 21:22: Gladys away until 21:29:30.
  while (clock.now() < Date.parse('2026-10-29T21:29:30Z')) {
    await clock.advance(TICK);
  }
  assert.equal(app.state.pending.length, 1, 'still within its 10 minutes');
  assert.equal(app.state.pending[0].at, Date.parse('2026-10-29T21:22:00Z'));
  down = false;
  await clock.advance(TICK);
  const [event] = sent(gladys);
  assert.equal(event.lead, '60');
  // Sent at about 21:30: about 52 minutes left, not the 60 of its queuing.
  const left = (Date.parse('2026-10-29T22:22:00Z') - clock.now()) / MIN;
  assert.ok(Math.abs(event.minutes_left - left) <= 1, `${event.minutes_left} vs ${left}`);
  assert.match(event.summary, new RegExp(`in ${event.minutes_left} min`));
  assert.match(event.summary_fr, new RegExp(`dans ${event.minutes_left} min`));
});

test('a tide event Gladys keeps refusing is dropped 10 minutes after its due instant', async (t) => {
  const { app, clock, gladys } = await ready(t, { config: { stations: '97120' } });
  gladys.publishSceneEvent = async () => {
    throw Object.assign(new Error('gladys restarting'), { status: 503 });
  };
  while (clock.now() < Date.parse('2026-10-29T21:22:00Z') + EVENT_LATE_MAX + 2 * TICK) {
    await clock.advance(TICK);
  }
  assert.equal(
    app.state.pending.filter((e) => e.data.lead === '60').length,
    0,
    'the lead 60 event is gone',
  );
});

test('a pending event dated in the future (a clock set back) is dropped, not sent', async (t) => {
  const { app, gladys } = await ready(t, { config: { stations: '97120' } });
  const now = app.now();
  app.state.pending.push({
    key: 'tide_coming',
    at: now + 10 * MIN,
    tideAt: now + 20 * MIN,
    data: { device: 'd', kind: 'high', lead: '15', station_name: 'x', height: 1, tide_time: 't' },
  });
  await app.flushEvents();
  assert.equal(app.state.pending.length, 0);
  assert.equal(sent(gladys).length, 0);
});

test('a 429 of Gladys on an event keeps it for the next tick', async (t) => {
  const { app, clock, gladys } = await ready(t, { config: { stations: '97120' } });
  const real = gladys.publishSceneEvent.bind(gladys);
  let answer = 429;
  gladys.publishSceneEvent = async (...args) => {
    if (answer) {
      throw Object.assign(new Error('busy'), { status: answer });
    }
    return real(...args);
  };
  await clock.advance(6 * MIN);
  assert.equal(app.state.pending.length, 1, 'kept after the 429');
  answer = 0;
  await clock.advance(TICK);
  assert.deepEqual(
    sent(gladys).map((e) => e.lead),
    ['60'],
  );
});

test('the events queued and the tides announced are saved at once', async (t) => {
  const saved = [];
  const env = {};
  const storage = {
    load: async () => undefined,
    save: async (value) => {
      saved.push({ at: env.clock?.now(), value });
    },
  };
  const { clock, gladys } = await ready(t, { storage, config: { stations: '97120' } });
  env.clock = clock;
  gladys.publishSceneEvent = () => new Promise(() => {}); // Gladys never answers
  await clock.advance(6 * MIN);
  const first = saved.find((s) => s.value.fired.length > 0);
  assert.ok(first, 'a save holding the tide announced');
  assert.equal(first.value.pending.length, 1);
  // Lead 60 due at 21:22: saved within the tick that queued it.
  assert.ok(first.at - Date.parse('2026-10-29T21:22:00Z') < TICK, new Date(first.at).toISOString());
});

test('events: minutes left never negative; every word of the search must match', () => {
  const station = { code: '90490', name: 'Havre-Fictif', timeZone: 'Canada/Atlantic' };
  const [event] = tideEvents({
    station,
    extremes: [{ t: FIXTURE_NOW, v: 3, kind: 'high' }],
    now: FIXTURE_NOW + 3 * MIN,
    fired: new Map(),
    device: 'x',
  });
  assert.equal(event.data.minutes_left, 0);
  const mk = (code, name) =>
    parseStation({
      code,
      id: 'a0a0a0a0a0a0a0a0a0a00001',
      officialName: name,
      provinceCode: 'QC',
      timeSeries: [{ code: 'wlp' }],
    });
  const list = [mk('00001', 'Saint-Jean'), mk('00002', 'Saint-Paul'), mk('00003', 'Port Jean')];
  assert.deepEqual(
    searchStations(list, 'saint jean').map((s) => s.code),
    ['00001'],
  );
});

// --- Recovery after a failure (I3) ---------------------------------------------------------

test('a 503 at the very first read: the station read 2 minutes after, not an hour', async (t) => {
  const service = iwlsService();
  let down = true;
  service.fail = () => (down ? json({}, 503) : undefined);
  const { app, clock } = await setup(t, { service });
  await app.start({ stations: '97120' });
  await drain(app, clock);
  down = false;
  for (let i = 0; i < 10 && !app.state.data.get(BAIE.code)?.curve.length; i += 1) {
    await clock.advance(TICK);
    await drain(app, clock);
  }
  assert.ok(app.state.data.get(BAIE.code)?.curve.length > 0, 'read within 5 minutes');
});

test('a 429 at the very first read: read as soon as the pause ends, the try given back', async (t) => {
  const service = iwlsService();
  let limited = true;
  service.fail = () => (limited ? json({}, 429, { 'retry-after': '60' }) : undefined);
  const { app, clock } = await setup(t, { service });
  await app.start({ stations: '97120' });
  await drain(app, clock);
  assert.equal(app.state.tries.has(`meta:${BAIE.code}`), false, 'the try given back');
  limited = false;
  for (let i = 0; i < 6 && !app.state.data.get(BAIE.code)?.curve.length; i += 1) {
    await clock.advance(TICK);
    await drain(app, clock);
  }
  assert.ok(app.state.data.get(BAIE.code)?.curve.length > 0, 'read within 3 minutes');
});

test('a 429 on the predictions or the observations gives the try back', async (t) => {
  for (const code of ['wlp', 'wlo']) {
    const service = iwlsService();
    let limited = false;
    service.fail = (call) =>
      limited && call.query['time-series-code'] === code
        ? json({}, 429, { 'retry-after': '60' })
        : undefined;
    const { app, clock } = await ready(t, { service, config: { stations: '97120' } });
    const before = app.state.tries.get(`${code === 'wlp' ? 'pred' : 'obs'}:${BAIE.code}`);
    limited = true;
    await clock.advance(code === 'wlp' ? 6 * H + MIN : 10 * MIN + TICK);
    await drain(app, clock);
    const after = app.state.tries.get(`${code === 'wlp' ? 'pred' : 'obs'}:${BAIE.code}`);
    assert.equal(after.at, before.at, `${code}: the try given back`);
    app.stop();
  }
});

test('the test button asks the station again a minute after a failed try', async (t) => {
  const service = iwlsService();
  let down = true;
  service.fail = (call) => (down && call.path === '/stations' ? json({}, 502) : undefined);
  const { app, clock } = await setup(t, { service });
  await app.start({ stations: '97120' });
  await drain(app, clock);
  down = false;
  await clock.advance(MIN);
  const answer = app.testConnection();
  await drain(app, clock);
  await clock.advance(REQUEST_GAP);
  const text = await answer;
  assert.match(text.en, /Baie-Imaginaire \(97120\)/);
});

test('a station id the API refuses: the station looked up again at once', async (t) => {
  const service = iwlsService();
  const { app, clock } = await ready(t, { service, config: { stations: '97120' } });
  const moved = { ...service.stations.get(BAIE.code)[0], id: 'c1c1c1c1c1c1c1c1c1c1c1c1' };
  service.stations.set(BAIE.code, [moved]);
  for (const key of [...service.series.keys()]) {
    service.series.set(key.replace(BAIE.id, moved.id), service.series.get(key));
  }
  service.metadata.set(moved.id, service.metadata.get(BAIE.id));
  service.series.delete(`${BAIE.id}|wlo`); // the old id: 400
  await clock.advance(10 * MIN + TICK);
  await drain(app, clock);
  for (let i = 0; i < 6; i += 1) {
    await clock.advance(TICK);
    await drain(app, clock);
  }
  assert.equal(app.state.stations.get(BAIE.code).id, moved.id);
});

// --- Client --------------------------------------------------------------------------------

function client(t, handler, options = {}) {
  const clock = testClock({ start: FIXTURE_NOW });
  const fetch = installFetch([[/./, (call) => handler(call, clock)]]);
  t.after(() => fetch.restore());
  const c = new IwlsClient({
    now: clock.now,
    monotonic: clock.monotonic,
    sleep: (ms) => clock.advance(ms),
    ...options,
  });
  return { c, clock, fetch };
}

test('slow answers: still one request at a time', async (t) => {
  let inFlight = 0;
  let peak = 0;
  const { c, clock } = client(t, async (call, clk) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => clk.timers.setTimeout(resolve, 3 * REQUEST_GAP));
    inFlight -= 1;
    return json([]);
  });
  const all = Promise.all([c.stations(), c.stations(), c.stations()]);
  for (let i = 0; i < 40; i += 1) {
    await clock.advance(REQUEST_GAP);
  }
  await all;
  assert.equal(peak, 1);
});

test('a 429 without Retry-After: 5 minutes, then 10, then 20', async (t) => {
  const pause = { until: 0, streak: 0 };
  const { c, clock } = client(t, () => json({}, 429), { pause });
  const lengths = [];
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(c.stations(), { kind: 'limited' });
    lengths.push(Math.round(c.pausedFor() / MIN));
    await clock.advance(c.pausedFor() + 1);
  }
  assert.deepEqual(lengths, [5, 10, 20]);
  assert.equal(pause.streak, 3);
});

test('every request carries a time limit', async (t) => {
  let signal;
  const { c } = client(t, (call) => {
    signal = call.init.signal;
    return json([]);
  });
  await c.stations();
  assert.ok(signal instanceof AbortSignal);
});

// --- App: states, buttons, configuration ---------------------------------------------------------

test('states: only for the features created, with a heartbeat', async (t) => {
  const { app, clock, gladys } = await setup(t);
  await app.start({ stations: '90490, 97120' });
  await drain(app, clock);
  const calls = [];
  const real = gladys.publishChangedStates.bind(gladys);
  gladys.publishChangedStates = (states, options) => {
    calls.push({ states, options });
    return real(states, options);
  };
  // Only Baie-Imaginaire created.
  await gladys.fake.deviceCreated(
    gladys.fake.discoveredDevices.find((d) => d.external_id.endsWith(BAIE.code)),
  );
  await app.fastLoop(app.generation, { force: true });
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.deepEqual(call.options, { heartbeat: HEARTBEAT });
    assert.ok(call.states.every((s) => s.device_feature_external_id.includes(`:${BAIE.code}:`)));
  }
  assert.equal(lastValue(gladys, HAVRE.code, FEATURES.NEXT_HIGH_MINUTES), undefined);
});

test('the predicted level moves every 15 minutes, not every minute (a small history)', async (t) => {
  const { clock, gladys } = await ready(t, { config: { stations: '97120' } });
  for (let i = 0; i < 60; i += 1) {
    await clock.advance(TICK);
  }
  const values = gladys.fake.states
    .filter((s) => s.device_feature_external_id.endsWith(':predicted-level'))
    .map((s) => s.state);
  const changes = values.filter((v, i) => i === 0 || v !== values[i - 1]).length;
  assert.ok(changes >= 2 && changes <= 4, `${changes} values in 30 minutes: ${values}`);
});

test('the test button waits for the round running, then shows its values', async (t) => {
  const { app, clock } = await setup(t);
  await app.start({ stations: '97120' });
  const answer = app.testConnection();
  await drain(app, clock);
  await clock.advance(REQUEST_GAP);
  const text = await answer;
  assert.match(text.en, /Baie-Imaginaire \(97120\) BC: predicted now/);
});

test('the search: the query bounded, 15 stations shown at most', async (t) => {
  const service = iwlsService();
  service.list = Array.from({ length: 20 }, (_, i) => ({
    ...service.list[1],
    code: String(80000 + i),
    id: `e1e1e1e1e1e1e1e1e1e1${String(1000 + i)}`,
    officialName: `Anse-Fictive ${i}`,
  }));
  const { app, clock } = await setup(t, { service });
  await app.start({ stations: '' });
  let answer = app.search({ query: 'anse' });
  await clock.advance(REQUEST_GAP);
  answer = await answer;
  assert.equal(answer.en.split('\n').filter((l) => l.startsWith('- ')).length, 15);
  assert.match(answer.en, /and 5 more/);
  const long = await app.search({ query: `zz${'x'.repeat(200)}` });
  assert.ok(long.en.length < 140, long.en);
});

test('getConfig failing: asked again after 1, 2, 4 minutes', async (t) => {
  const { app, clock } = await setup(t);
  const asked = [];
  let fails = 3;
  await app.connect(async () => {
    asked.push(Math.round((clock.now() - FIXTURE_NOW) / MIN));
    if (fails > 0) {
      fails -= 1;
      throw new Error('busy');
    }
    return { stations: '' };
  });
  await clock.advance(10 * CONFIG_RETRY_MIN);
  assert.deepEqual(asked, [0, 1, 3, 7]);
});

test('a slow getConfig answered after a newer configuration: the newer one wins', async (t) => {
  const { app } = await setup(t);
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const connecting = app.connect(() => slow.then(() => ({ stations: '90490' })));
  await new Promise((resolve) => setImmediate(resolve));
  await app.start({ stations: '97120' });
  release();
  await connecting;
  assert.deepEqual(app.config.codes, ['97120']);
});

test('a round of an old configuration does not write the error of the new one', async (t) => {
  const service = iwlsService();
  service.fail = (call) => (call.query.code === HAVRE.code ? json({}, 503) : undefined);
  const { app, clock } = await setup(t, { service });
  await app.start({ stations: '90490' });
  const old = app.round;
  // The new configuration has nothing to read: its round ends first.
  await app.start({ stations: '' });
  await drain(app, clock);
  await clock.advance(REQUEST_GAP);
  await old;
  assert.equal(app.lastError, undefined);
});

test('only the station of the very code asked is adopted', async (t) => {
  const service = iwlsService();
  const other = { ...service.stations.get(HAVRE.code)[0] };
  service.stations.set(BAIE.code, [other, ...service.stations.get(BAIE.code)]);
  const { app } = await ready(t, { service, config: { stations: '97120' } });
  assert.equal(app.state.stations.get(BAIE.code).name, 'Baie-Imaginaire');
});

test('predictions read again when less than a day of them is left', async (t) => {
  const service = iwlsService();
  const { app, clock } = await ready(t, { service, config: { stations: '97120' } });
  const data = app.state.data.get(BAIE.code);
  const end = app.now() + 20 * H;
  data.curve = data.curve.filter((p) => p.t < end);
  data.extremes = data.extremes.filter((e) => e.t < end);
  const before = service.count(/\/data$/, 'wlp');
  await clock.advance(PREDICTION_RETRY + MIN);
  await drain(app, clock);
  assert.equal(service.count(/\/data$/, 'wlp'), before + 1);
});

// --- Status notes (m3, m10) ------------------------------------------------------------------

test('a station without a 15-minute curve is named; unclassified tides are said', async (t) => {
  const service = iwlsService();
  service.series.set(`${BAIE.id}|wlp`, []);
  // A tide in the middle of a fall (lower than the one before, higher than
  // the one after, and on the curve itself): neither high nor low.
  const hilo = service.series.get(`${HAVRE.id}|wlp-hilo`).map((p) => ({ ...p }));
  hilo.splice(3, 0, { ...hilo[3], eventDate: '2026-10-30T05:30:00Z', value: 0.95 });
  service.series.set(`${HAVRE.id}|wlp-hilo`, hilo);
  const { gladys } = await ready(t, { service });
  const { en, fr } = gladys.fake.connectionStatus.message;
  assert.match(en, /No prediction curve every 15 minutes[^.]*Baie-Imaginaire/);
  assert.match(fr, /Pas de courbe de prédiction[^.]*Baie-Imaginaire/);
  assert.match(en, /could not be told high or low[^.]*Havre-Fictif/);
});

// --- /data (m1, m2) -------------------------------------------------------------------------------

test('a frozen /data never freezes the integration, writes are not stacked', async (t) => {
  let saves = 0;
  const storage = {
    load: async () => undefined,
    save: () => {
      saves += 1;
      return new Promise(() => {}); // never ends
    },
  };
  const { app, clock, service } = await setup(t, { storage });
  await app.start({ stations: '97120' });
  for (let i = 0; i < 20 && app.round; i += 1) {
    await clock.advance(STORE_TIMEOUT);
  }
  assert.ok(service.calls.length >= 5, 'the reads went on');
  assert.equal(saves, 1, 'one stuck write, no other stacked behind it');
});

test('a corrupt state file is set aside and the state saved again', async (t) => {
  let quarantined = 0;
  let saved;
  const storage = {
    load: async () => {
      throw new CorruptStateError(new Error('bad json'));
    },
    quarantine: async () => {
      quarantined += 1;
    },
    save: async (value) => {
      saved = value;
    },
  };
  const { app, clock, gladys } = await setup(t, { storage });
  await app.start({ stations: '97120' });
  await drain(app, clock);
  assert.equal(quarantined, 1);
  assert.ok(saved?.tries.length > 0, 'saved again');
  assert.match(gladys.fake.connectionStatus.message.en, /corrupt: set aside/);
});

test('a state file that cannot be read is read again at the next start', async (t) => {
  let reads = 0;
  const storage = {
    load: async () => {
      reads += 1;
      if (reads === 1) {
        throw new Error('EACCES');
      }
      return undefined;
    },
    save: async () => {},
  };
  const { app, clock } = await setup(t, { storage });
  await app.start({ stations: '' });
  assert.equal(app.storeBroken, true);
  await app.start({ stations: '' });
  await drain(app, clock);
  assert.equal(reads, 2);
  assert.equal(app.storeBroken, false);
});

// --- /data read back: bounds -----------------------------------------------------------------

test('from /data: no future observation, pending bounded, tries without a date dropped', () => {
  const raw = saveState(emptyState());
  raw.data = [['97120', { curve: [], extremes: [], obs: { t: FIXTURE_NOW + H, v: 1, qc: 1 } }]];
  raw.pending = Array.from({ length: 3 * MAX_PENDING_EVENTS }, () => ({
    key: 'tide_coming',
    at: FIXTURE_NOW,
    tideAt: FIXTURE_NOW + H,
    data: {},
  }));
  raw.tries = [
    ['obs:97120', { at: 'yesterday' }],
    ['pred:97120', { at: 0 }],
  ];
  const state = loadState(raw, FIXTURE_NOW);
  assert.equal(state.data.get('97120').obs, null);
  assert.equal(state.pending.length, MAX_PENDING_EVENTS);
  assert.equal(state.tries.size, 0);
});

test('memory bounds: station list, high and low tides, time zone formatters', () => {
  const entry = (i) => ({
    code: String(10000 + i),
    id: `a1a1a1a1a1a1a1a1a1a${String(10000 + i)}`,
    officialName: `S${i}`,
    timeSeries: [{ code: 'wlp' }],
  });
  assert.equal(
    parseStationList(Array.from({ length: MAX_LIST_ENTRIES + 50 }, (_, i) => entry(i))).length,
    MAX_LIST_ENTRIES,
  );
  const points = Array.from({ length: 2 * MAX_EXTREMES + 10 }, (_, i) => ({
    t: FIXTURE_NOW + i * 6 * H,
    v: i % 2 ? 2 : 0.5,
  }));
  assert.equal(classifyExtremes(points).length, MAX_EXTREMES);
  for (const zone of Intl.supportedValuesOf('timeZone').slice(0, 150)) {
    localTime(FIXTURE_NOW, zone);
  }
  assert.ok(formatCacheSize() <= 100, `${formatCacheSize()}`);
});

test('the curve decides a tide whose neighbours disagree', () => {
  const T0 = FIXTURE_NOW;
  const pts = [
    { t: T0, v: 1.0 },
    { t: T0 + 6 * H, v: 2.0 },
    { t: T0 + 12 * H, v: 3.0 },
  ];
  const curve = [];
  for (let t = T0 - 3 * H; t <= T0 + 16 * H; t += 15 * MIN) {
    curve.push({ t, v: t === T0 + 6 * H ? 2 : 1.5 });
  }
  assert.ok(classifyExtremes(pts, curve).some((e) => e.t === T0 + 6 * H && e.kind === 'high'));
});

test('a store in memory (the default) is asynchronous like the file', async () => {
  const storage = memoryStorage({ v: 1 });
  assert.deepEqual(await storage.load(), { v: 1 });
});

test('the states are published at most once a minute (the ticks come every 30 s)', async (t) => {
  const { clock, gladys } = await ready(t, { config: { stations: '97120' } });
  let calls = 0;
  const real = gladys.publishChangedStates.bind(gladys);
  gladys.publishChangedStates = (...args) => {
    calls += 1;
    return real(...args);
  };
  for (let i = 0; i < 10; i += 1) {
    await clock.advance(TICK);
  }
  assert.ok(calls >= 4 && calls <= 6, `${calls} publications in 5 minutes`);
});

test('a service that gives less than a day of predictions is asked again every 30 minutes, not more', async (t) => {
  const service = iwlsService();
  const short = (key) => {
    const end = FIXTURE_NOW + 20 * H;
    service.series.set(
      key,
      service.series.get(key).filter((p) => Date.parse(p.eventDate) < end),
    );
  };
  short(`${BAIE.id}|wlp`);
  short(`${BAIE.id}|wlp-hilo`);
  const { app, clock } = await ready(t, { service, config: { stations: '97120' } });
  const before = service.count(/\/data$/, 'wlp');
  for (let i = 0; i < 58; i += 1) {
    await clock.advance(TICK);
    await drain(app, clock);
  }
  // 29 minutes: none; one at 30.
  assert.equal(service.count(/\/data$/, 'wlp'), before);
  for (let i = 0; i < 4; i += 1) {
    await clock.advance(TICK);
    await drain(app, clock);
  }
  assert.equal(service.count(/\/data$/, 'wlp'), before + 1);
});

test('a stale point of the curve is not published as the predicted level', () => {
  const curve = [
    { t: FIXTURE_NOW - 2 * H, v: 1 },
    { t: FIXTURE_NOW - 40 * MIN, v: 2 },
  ];
  assert.equal(curveStep(curve, FIXTURE_NOW), null);
  assert.deepEqual(curveStep(curve, FIXTURE_NOW - 30 * MIN), curve[1]);
});

test('a FIFO in place of the state file: unreadable, never read as an empty state', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'marees-canada-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  execFileSync('mkfifo', [path]);
  await assert.rejects(
    fileStorage(path).load(),
    (err) => !(err instanceof CorruptStateError) && /unreadable/.test(err.message),
  );
});

test('the error of a station stays while nothing new is read', async (t) => {
  const service = iwlsService();
  service.fail = (call) =>
    call.query['time-series-code'] === 'wlp-hilo' ? json({}, 500) : undefined;
  const { app, clock } = await ready(t, { service, config: { stations: '97120' } });
  assert.equal(app.stationErrors.get(BAIE.code), 'server');
  await clock.advance(TICK);
  await drain(app, clock);
  assert.equal(app.stationErrors.get(BAIE.code), 'server', 'an idle tick does not clear it');
  assert.equal(app.lastError?.kind, 'server');
  assert.match(app.gladys.fake.connectionStatus.message.en, /Last read failed/);
});

// --- Review r2 (I4') ------------------------------------------------------------------------------

test('a try is written to /data before its request leaves, even after a quiet period (slow /data)', async (t) => {
  const env = { saving: 0, early: 0, requests: 0 };
  let mem;
  const storage = {
    load: async () => mem,
    save: (value) =>
      new Promise((resolve) => {
        env.saving += 1;
        env.clock.timers.setTimeout(() => {
          mem = JSON.parse(JSON.stringify(value));
          env.saving -= 1;
          resolve();
        }, 150);
      }),
  };
  const service = iwlsService();
  const handler = service.handler;
  service.handler = (call) => {
    env.requests += 1;
    if (env.saving > 0) {
      env.early += 1;
    }
    return handler(call);
  };
  const clock = testClock({ start: FIXTURE_NOW });
  env.clock = clock;
  const { app } = await setup(t, { storage, service, clock, config: { stations: '97120' } });
  await app.start({ stations: '97120' });
  await drain(app, clock);
  const before = env.requests;
  // The observations 10 minutes later: no request gap to wait behind.
  for (let i = 0; i < 22; i += 1) {
    await clock.advance(TICK);
    await drain(app, clock);
  }
  assert.ok(env.requests > before, 'the observations were read again');
  assert.equal(env.early, 0, 'no request while the save of its try was pending');
});

test('a station id refused on its data only: looked up once, then at most once a day', async (t) => {
  const service = iwlsService();
  const { app, clock } = await ready(t, { service, config: { stations: '97120' } });
  service.fail = (call) => (/\/data$/.test(call.path) ? json({}, 404) : undefined);
  const lookups = () => service.calls.filter((c) => c.query.code === BAIE.code).length;
  const before = lookups();
  for (let i = 0; i < 360; i += 1) {
    await clock.advance(TICK);
    await drain(app, clock);
  }
  const after = lookups() - before;
  assert.ok(after >= 1 && after <= 2, `${after} lookups in 3 hours`);
});

test('a 429 on the high and low tides keeps the curve just read', async (t) => {
  const service = iwlsService();
  service.fail = (call) =>
    call.query['time-series-code'] === 'wlp-hilo'
      ? json({}, 429, { 'retry-after': '3600' })
      : undefined;
  const { app } = await ready(t, { service, config: { stations: '97120' } });
  assert.ok(app.client.pausedFor() > 0);
  assert.ok(app.state.data.get(BAIE.code)?.curve.length > 100);
});

test('the summary of a lead-0 event says "now"', () => {
  const [event] = tideEvents({
    station: { code: '97120', name: 'Baie-Imaginaire', timeZone: 'Canada/Pacific' },
    extremes: [{ t: FIXTURE_NOW, v: 2.95, kind: 'high' }],
    now: FIXTURE_NOW + MIN,
    fired: new Map(),
    device: 'x',
  });
  assert.equal(event.data.lead, '0');
  assert.match(event.data.summary, /^High tide now at /);
  assert.match(event.data.summary_fr, /^Pleine mer maintenant à /);
});

test('the state is saved at shutdown; /data is read once, not at every start', async (t) => {
  let loads = 0;
  let saves = 0;
  const storage = {
    load: async () => {
      loads += 1;
      return undefined;
    },
    save: async () => {
      saves += 1;
    },
  };
  const { app, clock } = await setup(t, { storage });
  await app.start({ stations: '97120' });
  await drain(app, clock);
  await app.start({ stations: '97120' });
  await drain(app, clock);
  assert.equal(loads, 1);
  const before = saves;
  await app.shutdown();
  assert.equal(saves, before + 1);
});

test('from /data: a pending event without a believable tide time is dropped', () => {
  const raw = saveState(emptyState());
  raw.pending = [
    { key: 'tide_coming', at: FIXTURE_NOW, tideAt: 5, data: {} },
    { key: 'tide_coming', at: FIXTURE_NOW, tideAt: FIXTURE_NOW + H, data: {} },
  ];
  assert.equal(loadState(raw, FIXTURE_NOW).pending.length, 1);
});
