import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseStations, stationCode } from '../src/config.js';

test('station codes: 5 digits, leading zeros added, nothing else', () => {
  assert.equal(stationCode('00490'), '00490');
  assert.equal(stationCode(' 490 '), '00490');
  assert.equal(stationCode(7120), '07120');
  assert.equal(stationCode('0'), null);
  assert.equal(stationCode('123456'), null);
  assert.equal(stationCode('49O'), null);
  assert.equal(stationCode('__proto__'), null);
  assert.equal(stationCode(undefined), null);
});

test('the station list of the configuration', () => {
  assert.deepEqual(parseStations('00490, 7120;03057\n490  2985'), {
    codes: ['00490', '07120', '03057', '02985'],
    invalid: [],
  });
  assert.deepEqual(parseStations('Halifax, 00490').invalid, ['Halifax']);
  assert.deepEqual(parseStations(null), { codes: [], invalid: [] });
});

test('the configuration: bounds, defaults, never a string', () => {
  assert.deepEqual(normalizeConfig(), { codes: [], dropped: 0, invalid: [], pollMinutes: 10 });
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollMinutes, 5);
  assert.equal(normalizeConfig({ poll_interval: '600' }).pollMinutes, 60);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollMinutes, 10);
  assert.equal(normalizeConfig({ poll_interval: '  ' }).pollMinutes, 10);
  assert.equal(normalizeConfig({ poll_interval: null }).pollMinutes, 10);
  assert.equal(normalizeConfig({ poll_interval: 'abc' }).pollMinutes, 10);
  assert.equal(normalizeConfig({ poll_interval: 12.6 }).pollMinutes, 13);
  const many = Array.from({ length: 25 }, (_, i) => 10000 + i).join(',');
  const config = normalizeConfig({ stations: many });
  assert.equal(config.codes.length, 20);
  assert.equal(config.dropped, 5);
  assert.deepEqual(normalizeConfig('nonsense').codes, []);
});
