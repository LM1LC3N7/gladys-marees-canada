// -----------------------------------------------------------------------------
// The integration on a virtual clock (the clock moves between two reads),
// against a fake IWLS API built from real captures, with the SDK's fake
// Gladys: pacing, restarts, pauses, failures, silent gauges, tide events,
// status and buttons.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_RETRY_MIN,
  EVENT_LATE_MAX,
  FEATURES,
  MAX_STATIONS,
  RETRY_MIN,
  MIN_READ_GAP,
  PREDICTION_TTL,
  REQUEST_GAP,
  TICK,
  UNKNOWN_RETRY,
} from '../src/constants.js';
import { FEATURE_DEFS } from '../src/model.js';
import { memoryStorage } from '../src/store.js';
import { json } from './helpers/fakes.js';
import {
  FIXTURE_NOW,
  HAVRE,
  BAIE,
  createAll,
  drain,
  iwlsService,
  lastValue,
  setup,
} from './helpers/iwls.js';

const MIN = 60_000;
const data = (service) => service.count(/\/data$/);

/** Start, let the first round end, create the devices, publish. */
async function ready(t, options = {}) {
  const env = await setup(t, options);
  await env.app.start(options.config ?? { stations: '90490, 97120' });
  await drain(env.app, env.clock);
  await createAll(env.gladys);
  await env.app.fastLoop(env.app.generation, { force: true });
  return env;
}

test('first start: two stations resolved, ten requests, values published', async (t) => {
  const { gladys, service } = await ready(t);
  // Per station: the code, the metadata, the curve, the tides, the observations.
  assert.equal(service.calls.length, 10);
  const [halifax, victoria] = gladys.fake.discoveredDevices;
  assert.equal(halifax.name, 'Havre-Fictif (90490)');
  assert.equal(victoria.name, 'Baie-Imaginaire (97120)');
  assert.equal(halifax.features.length, FEATURE_DEFS.size);
  assert.equal(lastValue(gladys, '97120', FEATURES.NEXT_HIGH_HEIGHT), 2.95);
  assert.equal(lastValue(gladys, '97120', FEATURES.OBSERVED), 2.98);
  assert.equal(lastValue(gladys, '90490', FEATURES.NEXT_HIGH_MINUTES), 308);
  const texts = gladys.fake.states.filter((s) => 'text' in s).map((s) => s.text);
  assert.ok(texts.includes('2026-10-29 23:25 ADT'));
  assert.ok(texts.includes('2026-10-29 15:22 PDT'));
  const status = gladys.fake.connectionStatus;
  assert.equal(status.connected, true);
  assert.match(status.message.en, /current predictions for 2, a recent observation for 1 of the 2/);
  assert.match(status.message.en, /not for navigation/);
  assert.match(status.message.fr, /pas pour la navigation/);
});

test('an honest User-Agent, JSON asked, no redirect followed, small windows asked', async (t) => {
  const { service } = await ready(t);
  for (const call of service.calls) {
    assert.match(
      call.init.headers['User-Agent'],
      /^gladys-marees-canada \(\+https:\/\/github\.com/,
    );
    assert.equal(call.init.headers.Accept, 'application/json');
    assert.equal(call.init.redirect, 'error');
  }
  const obs = service.calls.find((c) => c.query['time-series-code'] === 'wlo');
  const span = Date.parse(obs.query.to) - Date.parse(obs.query.from);
  assert.ok(span <= 2 * 60 * MIN + 2 * MIN, `observations: ${span / MIN} min asked`);
  const curve = service.calls.find((c) => c.query['time-series-code'] === 'wlp');
  assert.equal(curve.query.resolution, 'FIFTEEN_MINUTES');
});

test('one request at a time, never two closer than the gap', async (t) => {
  const service = iwlsService();
  const at = [];
  let inFlight = 0;
  let peak = 0;
  const handler = service.handler;
  const env = await setup(t, { service });
  service.handler = async (call) => {
    at.push(env.clock.elapsed);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return handler(call);
  };
  await env.app.start({ stations: '90490, 97120' });
  // A click on Search while the round runs: it waits its turn.
  const search = env.app.search({ query: 'rimouski' });
  await drain(env.app, env.clock);
  await env.clock.advance(REQUEST_GAP);
  await search;
  assert.equal(peak, 1);
  assert.equal(at.length, 11);
  for (let i = 1; i < at.length; i += 1) {
    assert.ok(at[i] - at[i - 1] >= REQUEST_GAP, `gap ${i}: ${at[i] - at[i - 1]} ms`);
  }
});

test('observations every poll interval only; predictions every 6 hours; the station weekly', async (t) => {
  const { app, clock, service } = await ready(t);
  const before = service.calls.length;
  // 9 minutes of ticks: nothing due.
  await clock.advance(9 * MIN);
  await drain(app, clock);
  assert.equal(service.calls.length, before);
  // At 10 minutes: Baie-Imaginaire's observations only (Havre-Fictif's too: its gauge is silent but asked).
  await clock.advance(1 * MIN + TICK);
  await drain(app, clock);
  assert.equal(service.calls.length, before + 2);
  assert.equal(service.count(/\/data$/, 'wlo'), 4);
  // The second read asks from just after the last observation.
  const last = service.calls.filter((c) => c.query['time-series-code'] === 'wlo').at(-1);
  assert.ok(Date.parse(last.query.from) > FIXTURE_NOW - 2 * MIN);
  // Six hours later: predictions read again, the station not.
  await clock.advance(PREDICTION_TTL);
  await drain(app, clock);
  assert.equal(service.count(/\/data$/, 'wlp'), 4);
  assert.equal(service.count(/^\/stations$/), 2);
});

test('a restart never reads sooner: the tries are in /data before the requests', async (t) => {
  const storage = memoryStorage();
  const first = await ready(t, { storage });
  first.app.shutdown();
  const service = iwlsService();
  const { app, clock } = await setup(t, { storage, service, start: FIXTURE_NOW + 3 * MIN });
  await app.start({ stations: '90490, 97120' });
  await drain(app, clock);
  assert.equal(service.calls.length, 0, 'nothing due 3 minutes after the last read');
  await clock.advance(8 * MIN + TICK);
  await drain(app, clock);
  assert.deepEqual(
    service.calls.map((c) => c.query['time-series-code']),
    ['wlo', 'wlo'],
  );
});

test('a request that never ends is cut by its timeout; the try still counts', async (t) => {
  let written;
  const storage = {
    load: async () => undefined,
    save: async (value) => {
      written = value;
    },
  };
  const service = iwlsService();
  let saved;
  service.fail = (call) => {
    if (call.path === '/stations') {
      // The try was written before the request left.
      saved = JSON.stringify(written);
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    }
    return undefined;
  };
  const { app, clock } = await setup(t, { storage, service, config: {} });
  await app.start({ stations: '90490' });
  await drain(app, clock);
  assert.match(saved, /meta:90490/);
  assert.equal(service.calls.length, 1);
  assert.match(app.gladys.fake.connectionStatus.message.en, /network error/);
  // Again after 2 minutes, then 4, 8...: never at every tick.
  const times = [];
  for (let s = 30; s <= 20 * 60; s += 30) {
    const before = service.calls.length;
    await clock.advance(TICK);
    await drain(app, clock);
    if (service.calls.length > before) {
      times.push(s / 60);
    }
  }
  assert.deepEqual(times, [RETRY_MIN / MIN, (3 * RETRY_MIN) / MIN, (7 * RETRY_MIN) / MIN]);
});

test('a reconnection (start again) reads nothing sooner and publishes the status again', async (t) => {
  const { app, clock, service, gladys } = await ready(t);
  const before = service.calls.length;
  const statuses = gladys.fake.connectionStatuses.length;
  await app.start({ stations: '90490, 97120' });
  await drain(app, clock);
  await app.start({ stations: '90490, 97120' });
  await drain(app, clock);
  assert.equal(service.calls.length, before);
  assert.ok(gladys.fake.connectionStatuses.length > statuses, 'the status is sent again');
});

test('getConfig failing in connected: an error status, retried without end, then the start', async (t) => {
  const { app, clock, gladys, service } = await setup(t);
  let fails = 2;
  const loadConfig = async () => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('gladys busy');
    }
    return { stations: '97120' };
  };
  await app.connect(loadConfig);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /configuration could not be read/);
  assert.equal(service.calls.length, 0);
  await clock.advance(CONFIG_RETRY_MIN);
  assert.match(gladys.fake.connectionStatus.message.fr, /nouvel essai/);
  await clock.advance(2 * CONFIG_RETRY_MIN);
  await drain(app, clock);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(service.count(/^\/stations$/), 1);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
});

test('a 429: paused (Retry-After), nothing sent meanwhile, the pause survives a restart', async (t) => {
  const storage = memoryStorage();
  const service = iwlsService();
  let limited = true;
  service.fail = (call) =>
    limited && call.query['time-series-code'] === 'wlp'
      ? json({ message: 'too many' }, 429, { 'retry-after': '1800' })
      : undefined;
  const { app, clock, gladys } = await setup(t, { storage, service });
  await app.start({ stations: '90490, 97120' });
  await drain(app, clock);
  // The round stopped at the 429: Baie-Imaginaire not even asked.
  assert.equal(service.calls.length, 3);
  assert.match(gladys.fake.connectionStatus.message.en, /paused until/);
  limited = false;
  await clock.advance(20 * MIN);
  await drain(app, clock);
  assert.equal(service.calls.length, 3, 'nothing during the pause');
  app.shutdown();
  // A restart 25 minutes in: still 5 minutes of pause.
  const again = iwlsService();
  const second = await setup(t, { storage, service: again, start: FIXTURE_NOW + 25 * MIN });
  await second.app.start({ stations: '90490, 97120' });
  await drain(second.app, second.clock);
  assert.equal(again.calls.length, 0);
  await second.clock.advance(6 * MIN);
  await drain(second.app, second.clock);
  assert.ok(again.calls.length > 0, 'read again once the pause is over');
  // Nothing was tried during the pause: Baie-Imaginaire, never read, is asked at once.
  assert.ok(again.calls.some((c) => c.query.code === BAIE.code));
});

test('a 429 without Retry-After: at least a minute, at most 6 hours', async (t) => {
  const service = iwlsService();
  service.fail = () => json({}, 429);
  const { app, clock } = await setup(t, { service });
  await app.start({ stations: '97120' });
  await drain(app, clock);
  const left = app.client.pausedFor();
  assert.ok(left >= 60_000 && left <= 6 * 60 * MIN, `${left}`);
  assert.equal(service.calls.length, 1);
});

test('the metadata failing never stops the values: times in UTC, said', async (t) => {
  const service = iwlsService();
  service.fail = (call) => (call.path.endsWith('/metadata') ? json({}, 503) : undefined);
  const { gladys, app, clock } = await ready(t, { service });
  assert.equal(lastValue(gladys, '97120', FEATURES.OBSERVED), 2.98);
  const texts = gladys.fake.states.filter((s) => 'text' in s).map((s) => s.text);
  assert.ok(texts.includes('2026-10-29 22:22 UTC'));
  const pending = app.testConnection();
  await drain(app, clock);
  await clock.advance(REQUEST_GAP);
  const answer = await pending;
  assert.match(answer.en, /times in UTC/);
});

test('the high and low tides failing never stop the curve and the observations', async (t) => {
  const service = iwlsService();
  service.fail = (call) =>
    call.query['time-series-code'] === 'wlp-hilo' ? json({}, 500) : undefined;
  const { gladys } = await ready(t, { service });
  assert.equal(lastValue(gladys, '97120', FEATURES.OBSERVED), 2.98);
  assert.equal(typeof lastValue(gladys, '97120', FEATURES.PREDICTED), 'number');
  assert.equal(lastValue(gladys, '97120', FEATURES.NEXT_HIGH_HEIGHT), undefined);
});

test('a silent tide gauge: no observed value, no 0, said in the status', async (t) => {
  const { gladys } = await ready(t);
  assert.equal(lastValue(gladys, '90490', FEATURES.OBSERVED), undefined);
  assert.equal(lastValue(gladys, '90490', FEATURES.SURGE), undefined);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /No observation for 2 hours or more[^.]*Havre-Fictif/,
  );
  assert.match(gladys.fake.connectionStatus.message.fr, /Aucune observation depuis 2 heures/);
  for (const state of gladys.fake.states) {
    assert.ok(!('state' in state) || Number.isFinite(state.state));
  }
});

test('an observation that stops: published while recent, then no longer, said', async (t) => {
  const service = iwlsService();
  const { app, clock, gladys } = await ready(t, { service });
  service.series.set(`${BAIE.id}|wlo`, []);
  const published = () =>
    gladys.fake.states.filter((s) => s.device_feature_external_id.endsWith(':97120:observed-level'))
      .length;
  await clock.advance(60 * MIN);
  await drain(app, clock);
  const count = published();
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /Baie-Imaginaire/);
  await clock.advance(61 * MIN);
  await drain(app, clock);
  assert.match(gladys.fake.connectionStatus.message.en, /No observation[^.]*Baie-Imaginaire/);
  // The old value is not republished (no heartbeat of a stale value).
  await clock.advance(40 * MIN);
  assert.equal(published(), count);
});

test('a questionable observation is not published', async (t) => {
  const service = iwlsService();
  service.series.set(
    `${BAIE.id}|wlo`,
    service.series.get(`${BAIE.id}|wlo`).map((p) => ({ ...p, qcFlagCode: '3' })),
  );
  const { gladys } = await ready(t, { service });
  assert.equal(lastValue(gladys, '97120', FEATURES.OBSERVED), undefined);
  assert.match(gladys.fake.connectionStatus.message.en, /questionable[^.]*Baie-Imaginaire/);
});

test('unknown and invalid codes: said, the unknown one asked again only a day later', async (t) => {
  const { app, clock, gladys, service } = await setup(t);
  await app.start({ stations: '99999, abc, 7120' });
  await drain(app, clock);
  const { message } = gladys.fake.connectionStatus;
  assert.match(message.en, /Unknown station code\(s\): 99999/);
  assert.match(message.en, /ignored: abc/);
  assert.match(message.fr, /inconnu\(s\) : 99999/);
  const asked = () => service.calls.filter((c) => c.query.code === '99999').length;
  assert.equal(asked(), 1);
  await clock.advance(UNKNOWN_RETRY - 10 * MIN);
  await drain(app, clock);
  assert.equal(asked(), 1);
  await clock.advance(11 * MIN);
  await drain(app, clock);
  assert.equal(asked(), 2);
});

test('20 stations at most, said', async (t) => {
  const codes = Array.from({ length: MAX_STATIONS + 3 }, (_, i) => String(10000 + i)).join(',');
  const { app, gladys } = await setup(t);
  await app.start({ stations: codes });
  assert.equal(app.config.codes.length, MAX_STATIONS);
  assert.match(gladys.fake.connectionStatus.message.en, /Only the first 20 stations/);
  // 20 stations with every feature, published at most once a minute: under
  // the 300 states a minute Gladys takes.
  assert.ok(MAX_STATIONS * FEATURE_DEFS.size <= 300);
});

test('values published at most once a minute, the countdowns moving', async (t) => {
  const { app, clock, gladys } = await ready(t);
  const publishes = () =>
    gladys.fake.requests.filter((r) => r.path.includes('state') && r.method === 'POST').length;
  const before = publishes();
  for (let i = 0; i < 10; i += 1) {
    await clock.advance(TICK);
  }
  await drain(app, clock);
  const during = publishes() - before;
  assert.ok(during >= 4 && during <= 6, `${during} publications in 5 minutes`);
  // 309 at the start, 5 minutes of ticks: the last publication within the last minute.
  assert.ok(
    [302, 303, 304].includes(lastValue(gladys, '90490', FEATURES.NEXT_HIGH_MINUTES)),
    `${lastValue(gladys, '90490', FEATURES.NEXT_HIGH_MINUTES)}`,
  );
});

test('no state is published before the user created the device', async (t) => {
  const { app, clock, gladys } = await setup(t);
  await app.start({ stations: '97120' });
  await drain(app, clock);
  assert.equal(gladys.fake.states.length, 0);
  await createAll(gladys);
  await app.deviceCreated();
  assert.equal(lastValue(gladys, '97120', FEATURES.OBSERVED), 2.98);
});

test('a tide event at each lead, once, with every declared variable', async (t) => {
  const { app, clock, gladys } = await ready(t);
  // Baie-Imaginaire: high tide at 22:22 UTC, 66 minutes after the fixture instant. Lead 60 at 21:22.
  await clock.advance(6 * MIN);
  await drain(app, clock);
  const events = gladys.fake.sceneEvents.filter(
    (e) => e.data?.station === '97120' || e.station === '97120',
  );
  assert.equal(events.length, 1, JSON.stringify(gladys.fake.sceneEvents));
  const [event] = events;
  const body = event.data ?? event;
  assert.equal(body.kind, 'high');
  assert.equal(body.lead, '60');
  assert.equal(body.height, 2.95);
  assert.equal(body.tide_time, '2026-10-29 15:22 PDT');
  assert.equal(body.device, 'ext:marees-canada:station:97120');
  assert.match(body.summary, /High tide in 6\d min at Baie-Imaginaire/);
  assert.match(body.summary_fr, /Pleine mer dans 6\d min/);
  // Half an hour on: lead 30. At the tide: lead 0. Nothing twice.
  await clock.advance(30 * MIN);
  await clock.advance(30 * MIN);
  await drain(app, clock);
  const leads = gladys.fake.sceneEvents
    .map((e) => e.data ?? e)
    .filter((e) => e.station === '97120')
    .map((e) => `${e.kind}:${e.lead}`);
  assert.deepEqual(leads, ['high:60', 'high:30', 'high:15', 'high:0']);
});

test('a tide event is never sent twice, even after a restart', async (t) => {
  const storage = memoryStorage();
  const first = await ready(t, { storage });
  await first.clock.advance(6 * MIN);
  first.app.shutdown();
  assert.equal(first.gladys.fake.sceneEvents.length, 1);
  const second = await setup(t, { storage, start: FIXTURE_NOW + 7 * MIN });
  await second.app.start({ stations: '90490, 97120' });
  await drain(second.app, second.clock);
  assert.equal(second.gladys.fake.sceneEvents.length, 0);
});

test('a tide event later than 10 minutes is dropped, never sent late', async (t) => {
  const { app, clock, gladys } = await ready(t);
  const real = gladys.publishSceneEvent.bind(gladys);
  let down = true;
  gladys.publishSceneEvent = async (...args) => {
    if (down) {
      throw Object.assign(new Error('gladys restarting'), { status: 503 });
    }
    return real(...args);
  };
  await clock.advance(6 * MIN);
  assert.equal(app.state.pending.length, 1, 'kept for later');
  await clock.advance(EVENT_LATE_MAX);
  down = false;
  await clock.advance(TICK);
  assert.equal(gladys.fake.sceneEvents.length, 0);
  assert.equal(app.state.pending.length, 0);
});

test('a tide event refused for good (4xx) does not block the next ones', async (t) => {
  const { app, clock, gladys } = await ready(t);
  const real = gladys.publishSceneEvent.bind(gladys);
  let refuse = 1;
  gladys.publishSceneEvent = async (...args) => {
    if (refuse > 0) {
      refuse -= 1;
      throw Object.assign(new Error('bad payload'), { status: 400 });
    }
    return real(...args);
  };
  await clock.advance(6 * MIN);
  await clock.advance(30 * MIN);
  await drain(app, clock);
  assert.deepEqual(
    gladys.fake.sceneEvents.map((e) => (e.data ?? e).lead),
    ['30'],
  );
});

test('the test button: reads the observations a minute after the last read, shows every station', async (t) => {
  const { app, clock, service } = await ready(t);
  const obs = () => service.count(/\/data$/, 'wlo');
  const before = obs();
  let answer = app.testConnection();
  await drain(app, clock);
  answer = await answer;
  assert.equal(obs(), before, 'never closer than a minute');
  assert.match(
    answer.en,
    /Baie-Imaginaire \(97120\) BC: predicted now 2\.\d\d m, high tide 2026-10-29 15:22 PDT \(2\.95 m, in 6\d min\), low tide 2026-10-29 21:48 PDT \(0\.49 m/,
  );
  assert.match(
    answer.fr,
    /observé 2,98 m à 2026-10-29 14:16 PDT \(écart à la prédiction 0,2\d m\)/,
  );
  assert.match(answer.fr, /Havre-Fictif \(90490\) NS[^\n]*aucune observation récente/);
  assert.match(answer.en, /Notice: Invented notice of a fictional port authority/);
  assert.match(answer.fr, /Avis : Avis inventé d'une autorité portuaire fictive/);
  assert.match(answer.fr, /pas pour la navigation/);
  await clock.advance(MIN_READ_GAP);
  answer = app.testConnection();
  await drain(app, clock);
  await answer;
  assert.equal(obs(), before + 2);
});

test('the test button without station, and the search', async (t) => {
  const { app, clock, service } = await setup(t);
  await app.start({ stations: '' });
  const empty = await app.testConnection();
  assert.match(empty.en, /No station chosen/);
  assert.equal(service.calls.length, 0);
  let found = app.search({ query: 'Pointe aux exemples' });
  await clock.advance(REQUEST_GAP);
  found = await found;
  assert.match(found.en, /- 92985: Pointe-aux-Exemples \(QC\), predictions, measurements/);
  assert.match(found.fr, /Copiez le code/);
  const none = await app.search({ query: 'Atlantis' });
  assert.match(none.fr, /Aucune station ne correspond à « Atlantis »/);
  assert.equal(service.count(/^\/stations$/), 1, 'the list is kept a day');
  const blank = await app.search({ query: ' ' });
  assert.match(blank.en, /Type a few letters/);
});

test('the search: a list that fails is not asked again for 5 minutes', async (t) => {
  const service = iwlsService();
  service.fail = () => json({}, 502);
  const { app, clock } = await setup(t, { service });
  await app.start({ stations: '' });
  let answer = app.search({ query: 'Havre' });
  await clock.advance(REQUEST_GAP);
  answer = await answer;
  assert.match(answer.en, /could not be read/);
  await app.search({ query: 'Havre' });
  assert.equal(service.calls.length, 1);
});

test('another station behind the same code: the old data is dropped', async (t) => {
  const service = iwlsService();
  const { app, clock } = await ready(t, { service });
  const moved = { ...service.stations.get(HAVRE.code)[0], id: 'aaaaaaaaaaaaaaaaaaaaaaaa' };
  service.stations.set(HAVRE.code, [moved]);
  await clock.advance(7 * 24 * 60 * MIN + MIN);
  await drain(app, clock);
  assert.equal(app.state.stations.get(HAVRE.code).id, 'aaaaaaaaaaaaaaaaaaaaaaaa');
  // The new id has no series in the fake: nothing of the old station kept.
  assert.deepEqual(app.state.data.get(HAVRE.code).curve, []);
});

test('a state file that cannot be read is never overwritten', async (t) => {
  let saves = 0;
  const storage = {
    load() {
      throw new Error('state file corrupt');
    },
    save() {
      saves += 1;
    },
  };
  const { app, clock, gladys } = await setup(t, { storage });
  await app.start({ stations: '97120' });
  await drain(app, clock);
  app.shutdown();
  assert.equal(saves, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /state file in \/data cannot be read/);
});

test('a container clock far from the service clock is said', async (t) => {
  const service = iwlsService();
  const handler = service.handler;
  service.handler = async (call) => {
    const response = await handler(call);
    const headers = new Headers(response.headers);
    headers.set('date', new Date(FIXTURE_NOW + 20 * MIN).toUTCString());
    return new Response(await response.text(), { status: response.status, headers });
  };
  const { gladys } = await ready(t, { service });
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /differs from the one of the service by (19|20) min/,
  );
});

test('three network failures in a row stop the round (the host is down)', async (t) => {
  const service = iwlsService();
  service.fail = () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  };
  const { app, clock, gladys } = await setup(t, { service });
  await app.start({ stations: '90490, 97120, 92985, 93057' });
  await drain(app, clock);
  assert.equal(service.calls.length, 3);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /network error/);
});

test('one station failing does not stop the others', async (t) => {
  const service = iwlsService();
  service.fail = (call) => (call.query.code === HAVRE.code ? json({}, 500) : undefined);
  const { gladys } = await ready(t, { service });
  assert.equal(lastValue(gladys, '97120', FEATURES.OBSERVED), 2.98);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(data(service), 3);
});

test('predictions that fail are asked again after 2, 4, 8... minutes, up to 30', async (t) => {
  const service = iwlsService();
  service.fail = (call) =>
    call.query['time-series-code'] === 'wlp-hilo' ? json({}, 500) : undefined;
  const { app, clock } = await ready(t, { service, config: { stations: '97120' } });
  const asked = () => service.count(/\/data$/, 'wlp-hilo');
  const times = [];
  for (let minute = 0; minute < 120; minute += 0.5) {
    const before = asked();
    await clock.advance(TICK);
    await drain(app, clock);
    if (asked() > before) {
      times.push(minute + 0.5);
    }
  }
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  // The ticks come every 30 s: each wait is its value, or half a minute more.
  for (const [i, wait] of [4, 8, 16, 30].entries()) {
    assert.ok(gaps[i] >= wait && gaps[i] <= wait + 0.5, `asked at ${times}`);
  }
  assert.ok(
    gaps.every((g) => g <= 31),
    `${gaps}`,
  );
  assert.ok(times[0] >= 2 && times[0] <= 3, `first retry ${times[0]}`);
});

test('an empty prediction answer keeps the curve known', async (t) => {
  const service = iwlsService();
  const { app, clock, gladys } = await ready(t, { service, config: { stations: '97120' } });
  service.series.set(`${BAIE.id}|wlp`, []);
  service.series.set(`${BAIE.id}|wlp-hilo`, []);
  await clock.advance(PREDICTION_TTL + MIN);
  await drain(app, clock);
  await clock.advance(2 * MIN);
  assert.equal(app.state.data.get(BAIE.code).curve.length > 100, true);
  const predicted = gladys.fake.states.filter((s) =>
    s.device_feature_external_id.endsWith(':97120:predicted-level'),
  );
  assert.ok(predicted.length > 3, 'still published from the curve known');
  assert.ok(app.state.data.get(BAIE.code).extremes.length > 0);
});
