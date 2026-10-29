// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout), sped
// up 20 times, against a real local HTTP server playing the IWLS API (the
// real captures of test/fixtures): the observations are read at 0, the
// interval and twice the interval, never sooner, the requests one at a time
// and REQUEST_GAP apart, with a bounded number of timers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TidesApp } from '../src/app.js';
import { REQUEST_GAP } from '../src/constants.js';
import { memoryStorage } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/index.mjs';

const SPEED = 20;
const POLL_MINUTES = 5;
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('real clock: observations at 0, the interval, twice the interval; requests paced', async () => {
  const station = fixture('baie-station.json');
  const id = station[0].id;
  const routes = new Map([
    ['/api/v1/stations', station],
    [`/api/v1/stations/${id}/metadata`, fixture('baie-metadata.json')],
  ]);
  const series = {
    wlp: fixture('baie-wlp.json'),
    'wlp-hilo': fixture('baie-hilo.json'),
    wlo: fixture('baie-wlo.json'),
  };
  const arrivals = [];
  let inFlight = 0;
  let peak = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    arrivals.push(performance.now() * SPEED);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const body =
      url.pathname === `/api/v1/stations/${id}/data`
        ? (series[url.searchParams.get('time-series-code')] ?? [])
        : routes.get(url.pathname);
    // A little latency: a second request would overlap if the client did not wait.
    setTimeout(() => {
      inFlight -= 1;
      res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? {}));
    }, 5);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ selector: 'marees-canada', config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new TidesApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    storage: memoryStorage(),
    baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`,
  });
  const spy = spyOn(app, 'readObservations', clock);
  // The instants the requests leave (the arrivals at the server are blurred
  // by the latency of a cold first fetch).
  const sends = spyOn(globalThis, 'fetch', clock);
  try {
    await app.start({ stations: '97120', poll_interval: POLL_MINUTES });
    const gaps = await measurePeriod(spy, { count: 3, period: POLL_MINUTES * 60_000 });
    assert.equal(gaps.length, 2);
    // The third read decided: let its request reach the server.
    await clock.sleep(5_000);
  } finally {
    sends.restore();
    app.stop();
    clock.close();
    await new Promise((resolve) => server.close(resolve));
  }
  // The first round: code, metadata, curve, tides, observations; then two reads.
  assert.equal(arrivals.length, 7, `${arrivals.length} requests`);
  assert.equal(peak, 1, 'one request at a time');
  assert.equal(sends.calls.length, 7);
  for (let i = 1; i < 5; i += 1) {
    const gap = sends.calls[i].at - sends.calls[i - 1].at;
    // The client stamps its gap a few µs before calling fetch: two real ms
    // (×2: 40 simulated) of slack for the code between the stamp and the call.
    assert.ok(gap >= REQUEST_GAP - 2 * SPEED, `gap ${i}: ${Math.round(gap)} ms`);
    assert.ok(gap < 1.5 * REQUEST_GAP, `gap ${i}: ${Math.round(gap)} ms`);
  }
  // A tick every 30 s, a request gap, a time bound per write of /data (a
  // dozen a round): bounded, not growing with the time.
  assert.ok(clock.timersSet < 120, `${clock.timersSet} timers`);
});
