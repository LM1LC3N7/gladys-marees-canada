import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_LATE_MAX, LEADS } from '../src/constants.js';
import { firedKey, pruneFired, tideEvents } from '../src/triggers.js';

const H = 60 * 60_000;
const T0 = Date.parse('2026-10-29T22:22:00Z');
const station = { code: '97120', name: 'Baie-Imaginaire', timeZone: 'Canada/Pacific' };
const tide = { t: T0, v: 2.95, kind: 'high' };

test('one event per tide and lead, inside its 10 minutes only', () => {
  const fired = new Map();
  const at = (now) => tideEvents({ station, extremes: [tide], now, fired, device: 'd' });
  assert.equal(at(T0 - 3 * H - 1).length, 0, 'not before 3 hours ahead');
  assert.deepEqual(
    at(T0 - 3 * H).map((e) => e.data.lead),
    ['180'],
  );
  assert.equal(at(T0 - 3 * H + 1000).length, 0, 'not twice');
  // 11 minutes late: dropped.
  assert.equal(at(T0 - 2 * H + EVENT_LATE_MAX + 60_000).length, 0);
  // At the tide: lead 0 only (lead 15 is 15 minutes late by then).
  assert.deepEqual(
    at(T0).map((e) => e.data.lead),
    ['0'],
  );
  assert.equal(fired.get(firedKey('97120', 'high', 0)), T0);
  assert.equal(fired.has(firedKey('97120', 'high', 15)), false);
  assert.deepEqual(LEADS, [0, 15, 30, 60, 120, 180]);
});

test('a tide read again a minute later is the same tide; the next one is not', () => {
  const fired = new Map();
  tideEvents({ station, extremes: [tide], now: T0, fired, device: 'd' });
  const moved = { ...tide, t: T0 + 60_000 };
  assert.equal(
    tideEvents({ station, extremes: [moved], now: T0 + 60_000, fired, device: 'd' }).length,
    0,
  );
  const next = { ...tide, t: T0 + 12.4 * H };
  assert.equal(
    tideEvents({ station, extremes: [next], now: next.t, fired, device: 'd' }).length,
    1,
  );
  pruneFired(fired, T0 + 30 * H);
  assert.equal(fired.size, 1, 'the day-old tide forgotten, the recent kept');
});
