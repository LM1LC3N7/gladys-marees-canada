// -----------------------------------------------------------------------------
// A fake IWLS API on the synthetic answers of test/fixtures (same shape as
// the real ones, invented stations, see .github/scripts/fixtures.mjs), around 2026-10-29
// 21:16 UTC: Havre-Fictif (90490, predictions, its tide gauge silent) and
// Baie-Imaginaire (97120, predictions and observations every minute). The series answers keep the points inside the
// window asked, as the API does; `fail(call)` may answer instead (an error,
// a 429...). Plus the shared test plumbing: the app on a virtual clock.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TidesApp } from '../../src/app.js';
import { REQUEST_GAP } from '../../src/constants.js';
import { memoryStorage } from '../../src/store.js';
import { settle, testClock } from '../kit/index.mjs';
import { fixture, installFetch, json, quiet } from './fakes.js';

/** The instant of the captures. */
export const FIXTURE_NOW = Date.parse('2026-10-29T21:16:29Z');

export const HAVRE = { code: '90490', id: 'a0a0a0a0a0a0a0a0a0a09049' };
export const BAIE = { code: '97120', id: 'b0b0b0b0b0b0b0b0b0b09712' };

export function iwlsService() {
  const stations = new Map([
    [HAVRE.code, fixture('havre-station.json')],
    [BAIE.code, fixture('baie-station.json')],
  ]);
  const metadata = new Map([
    [HAVRE.id, fixture('havre-metadata.json')],
    [BAIE.id, fixture('baie-metadata.json')],
  ]);
  const series = new Map([
    [`${HAVRE.id}|wlp`, fixture('havre-wlp.json')],
    [`${HAVRE.id}|wlp-hilo`, fixture('havre-hilo.json')],
    [`${HAVRE.id}|wlo`, []],
    [`${BAIE.id}|wlp`, fixture('baie-wlp.json')],
    [`${BAIE.id}|wlp-hilo`, fixture('baie-hilo.json')],
    [`${BAIE.id}|wlo`, fixture('baie-wlo.json')],
  ]);
  const service = {
    stations,
    metadata,
    series,
    list: fixture('stations-subset.json'),
    /** (call) => Response | undefined: answers before the normal route. */
    fail: () => undefined,
    calls: [],
    handler(call) {
      const url = new URL(call.url);
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const entry = { path, query: Object.fromEntries(url.searchParams), init: call.init };
      service.calls.push(entry);
      const failed = service.fail(entry);
      if (failed) {
        return failed;
      }
      if (path === '/stations') {
        if (url.searchParams.has('code')) {
          const station = stations.get(url.searchParams.get('code'));
          return json(station ?? []);
        }
        return json(service.list);
      }
      let m = /^\/stations\/([^/]+)\/metadata$/.exec(path);
      if (m) {
        return metadata.has(m[1]) ? json(metadata.get(m[1])) : json({ status: '404' }, 404);
      }
      m = /^\/stations\/([^/]+)\/data$/.exec(path);
      if (m) {
        const code = url.searchParams.get('time-series-code');
        const from = Date.parse(url.searchParams.get('from'));
        const to = Date.parse(url.searchParams.get('to'));
        if (to - from > 7 * 24 * 60 * 60_000 && code !== 'wlp-hilo') {
          return json(fixture('error-400.json'), 400);
        }
        const points = series.get(`${m[1]}|${code}`);
        if (!points) {
          return json(fixture('error-400.json'), 400);
        }
        return json(
          points.filter((p) => Date.parse(p.eventDate) >= from && Date.parse(p.eventDate) <= to),
        );
      }
      return json({ status: '404' }, 404);
    },
    /** The calls to a path pattern (e.g. /data$/), or with a series code. */
    count(pattern, code) {
      return service.calls.filter(
        (c) => pattern.test(c.path) && (!code || c.query['time-series-code'] === code),
      ).length;
    },
  };
  return service;
}

/**
 * The app on a virtual clock, its fetch on a fake IWLS API, a fake Gladys.
 * `t.after` restores the fetch and stops the app.
 */
export async function setup(
  t,
  {
    config = { stations: '90490, 97120' },
    storage = memoryStorage(),
    start = FIXTURE_NOW,
    service = iwlsService(),
    clock = testClock({ start }),
    gladysOptions = {},
  } = {},
) {
  const fetch = installFetch([[/./, (call) => service.handler(call)]]);
  // The virtual clock fires its first timer before the pending promises run:
  // let them run first, as a real event loop would.
  if (!clock.settled) {
    const advance = clock.advance.bind(clock);
    clock.advance = async (ms) => {
      await settle(3);
      return advance(ms);
    };
    clock.settled = true;
  }
  const gladys = createFakeGladys({ selector: 'marees-canada', config, ...gladysOptions });
  await gladys.connect();
  const app = new TidesApp({
    gladys,
    logger: quiet,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    storage,
  });
  t.after(() => {
    app.stop();
    fetch.restore();
  });
  return { app, gladys, clock, service, storage, fetch };
}

/** Let the running read round finish, the virtual clock moving request gap by request gap. */
export async function drain(app, clock, max = 200) {
  for (let i = 0; i < max && app.round; i += 1) {
    await clock.advance(REQUEST_GAP);
  }
  if (app.round) {
    throw new Error('the read round never ended');
  }
}

/** Create in the fake Gladys every device of the Discovery tab, as a user would. */
export async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

/** The last value published for a feature key of a station. */
export const lastValue = (gladys, code, key) =>
  gladys.fake.lastState(`ext:marees-canada:station:${code}:${key}`);
