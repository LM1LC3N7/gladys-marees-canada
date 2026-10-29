// -----------------------------------------------------------------------------
// The HTTP client: bounded answers, statuses, the 429 pause and its bounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IwlsClient, apiDate, isStationId } from '../src/client.js';
import { LIMITED_MAX, MAX_SERIES_BODY, REQUEST_GAP } from '../src/constants.js';
import { testClock } from './kit/index.mjs';
import { installFetch, json } from './helpers/fakes.js';
import { FIXTURE_NOW, BAIE } from './helpers/iwls.js';

function client(t, handler, options = {}) {
  const clock = testClock({ start: FIXTURE_NOW });
  const fetch = installFetch([[/./, handler]]);
  t.after(() => fetch.restore());
  const c = new IwlsClient({
    now: clock.now,
    monotonic: clock.monotonic,
    // The wait for the gap moves the virtual clock on.
    sleep: (ms) => clock.advance(ms),
    ...options,
  });
  return { c, clock, fetch };
}

test('an answer larger than the bound is cut before it is read whole', async (t) => {
  let pulled = 0;
  const { c } = client(t, () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const body = new ReadableStream({
      pull(controller) {
        pulled += chunk.length;
        controller.enqueue(chunk);
        if (pulled > 50 * MAX_SERIES_BODY) {
          controller.close();
        }
      },
    });
    return new Response(body, { status: 200 });
  });
  await assert.rejects(c.series(BAIE.id, 'wlo', FIXTURE_NOW - 60_000, FIXTURE_NOW), {
    kind: 'network',
  });
  assert.ok(pulled <= MAX_SERIES_BODY + 3 * 64 * 1024, `${pulled} bytes pulled`);
});

test('statuses: 400 refused, 404, 5xx, a 2xx that is not the expected JSON', async (t) => {
  let answer;
  const slept = [];
  let advance;
  const { c, clock } = client(t, () => answer, {
    sleep: async (ms) => {
      slept.push(ms);
      await advance(ms);
    },
  });
  advance = (ms) => clock.advance(ms);
  answer = json({ message: 'Wrong parameter format' }, 400);
  await assert.rejects(c.metadata(BAIE.id), { kind: 'refused' });
  answer = json({}, 404);
  await assert.rejects(c.metadata(BAIE.id), { kind: 'not_found' });
  answer = json({}, 503);
  await assert.rejects(c.metadata(BAIE.id), { kind: 'server' });
  answer = json([1, 2]);
  await assert.rejects(c.metadata(BAIE.id), { kind: 'answer' });
  answer = new Response('<html>maintenance</html>', { status: 200 });
  await assert.rejects(c.stations(), { kind: 'answer' });
  // Each request waited for the gap after the previous one.
  assert.equal(slept.length, 5, 'the first request waits the gap too');
  assert.ok(slept.every((ms) => ms > REQUEST_GAP - 500 && ms <= REQUEST_GAP));
});

test('ids and codes are checked before any request', async (t) => {
  const { c, fetch } = client(t, () => json([]));
  await assert.rejects(c.metadata('../admin'), { kind: 'answer', sent: false });
  await assert.rejects(c.series('x/../y', 'wlo', 0, 1), { kind: 'answer', sent: false });
  await assert.rejects(c.stationByCode('490'), { kind: 'answer', sent: false });
  assert.equal(fetch.calls.length, 0);
  assert.equal(isStationId('b0b0b0b0b0b0b0b0b0b09712'), true);
  assert.equal(isStationId('B0B0B0B0B0B0B0B0B0B09712'), false);
  assert.equal(apiDate(Date.parse('2026-10-29T21:16:29.789Z')), '2026-10-29T21:16:29Z');
});

test('a 429 with an HTTP date: paused until then, no request meanwhile, then cleared', async (t) => {
  const pause = { until: 0, streak: 0 };
  let answer = json({}, 429, { 'retry-after': new Date(FIXTURE_NOW + 15 * 60_000).toUTCString() });
  let changes = 0;
  const { c, clock, fetch } = client(t, () => answer, {
    pause,
    onPauseChange: () => (changes += 1),
  });
  await assert.rejects(c.stations(), { kind: 'limited', sent: true });
  assert.ok(c.pausedFor() > 14 * 60_000 && c.pausedFor() <= 15 * 60_000);
  assert.ok(pause.until > FIXTURE_NOW && pause.streak === 1 && changes === 1);
  await assert.rejects(c.stations(), { kind: 'limited', sent: false });
  assert.equal(fetch.calls.length, 1);
  await clock.advance(15 * 60_000);
  answer = json([]);
  assert.deepEqual(await c.stations(), []);
  assert.deepEqual(pause, { until: 0, streak: 0 });
});

test('a pause read back from /data is capped to 6 hours', (t) => {
  const { c } = client(t, () => json([]), {
    pause: { until: FIXTURE_NOW + 1000 * LIMITED_MAX, streak: 3 },
  });
  assert.ok(c.pausedFor() <= LIMITED_MAX);
  assert.ok(c.pausedFor() > LIMITED_MAX - 1000);
});

test('the Date of the service tells the clock skew', async (t) => {
  const { c } = client(t, () =>
    json([], 200, { date: new Date(FIXTURE_NOW - 10 * 60_000).toUTCString() }),
  );
  assert.ok(Number.isNaN(c.skew));
  await c.stations();
  // The clock moved on by the gap of the first request.
  assert.ok(Math.abs(c.skew + 10 * 60_000) <= REQUEST_GAP + 1000, `${c.skew}`);
});

test('a pause refuses at once, even long after the last request, and ends', async (t) => {
  let answer = json({}, 429, { 'retry-after': '0' });
  const { c, clock, fetch } = client(t, () => answer);
  await assert.rejects(c.stations(), { kind: 'limited' });
  // Retry-After 0: a minute at least.
  assert.ok(c.pausedFor() >= 59_000, `${c.pausedFor()}`);
  await clock.advance(30_000);
  await assert.rejects(c.stations(), { kind: 'limited', sent: false });
  assert.equal(fetch.calls.length, 1);
  await clock.advance(31_000);
  answer = json([]);
  assert.deepEqual(await c.stations(), []);
});

test('a pause from /data far ahead ends after 6 hours at most', async (t) => {
  const { c, clock } = client(t, () => json([]), {
    pause: { until: FIXTURE_NOW + 1000 * LIMITED_MAX, streak: 3 },
  });
  await clock.advance(LIMITED_MAX + 60_000);
  assert.equal(c.pausedFor(), 0);
  assert.deepEqual(await c.stations(), []);
});
