// -----------------------------------------------------------------------------
// The answers of the IWLS API -> plain stations and points, the tide values
// computed from them, and the Gladys devices and states. Pure: `now` is a
// parameter.
//
// Everything read from the network is data, never a key: codes and ids are
// checked, every lookup goes through a Map, every number through `num()`.
//
// Heights are in metres above the chart datum of the station, as the API
// gives them (no conversion); dates are ISO 8601 UTC ("...Z"), shown in the
// time zone of the station.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { searchable, stationCode } from './config.js';
import { isStationId } from './client.js';
import {
  ABERRANT_FUTURE,
  DEVICE_TYPE,
  FEATURES,
  KINDS,
  LEVEL_MAX,
  LEVEL_MIN,
  MAX_CURVE_GAP,
  MAX_EXTREMES,
  MAX_LIST_ENTRIES,
  MAX_POINTS,
  OBSERVATION_STALE,
  OLDEST_BELIEVED,
  SERIES,
} from './constants.js';

// --- Plain values ------------------------------------------------------------------

/** A finite number (a JSON number only), else null. */
export const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** A plausible water level (m), else null. */
export const level = (value) => {
  const n = num(value);
  return n !== null && n >= LEVEL_MIN && n <= LEVEL_MAX ? n : null;
};

/** A printable string: control characters removed, trimmed, bounded. */
export function cleanText(value, max = 80) {
  if (typeof value !== 'string') {
    return '';
  }
  return [...value]
    .filter((c) => c.charCodeAt(0) >= 0x20 && !(c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) < 0xa0))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** An ISO date in UTC with its "Z" or an offset -> ms; a date without one is refused. */
export function parseTime(text) {
  if (typeof text !== 'string' || text.length > 40) {
    return NaN;
  }
  const trimmed = text.trim();
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:?[0-9]{2})$/.test(trimmed)) {
    return NaN;
  }
  const t = Date.parse(trimmed);
  return Number.isFinite(t) && t >= OLDEST_BELIEVED ? t : NaN;
}

// --- Time zones ------------------------------------------------------------------------

const formats = new Map();

/** The formatter of a time zone, or null when the runtime does not know it. */
function formatOf(timeZone) {
  if (formats.has(timeZone)) {
    return formats.get(timeZone);
  }
  let format;
  try {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
  } catch {
    format = null;
  }
  if (formats.size < 100) {
    formats.set(timeZone, format);
  }
  return format;
}

/** How many time zone formatters are kept (bounded: 100). */
export const formatCacheSize = () => formats.size;

/** A time zone name the runtime knows ("Canada/Atlantic", "America/Halifax"), else null. */
export function timeZoneOf(value) {
  const text = cleanText(value, 60);
  return /^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/.test(text) && formatOf(text) ? text : null;
}

/**
 * A time as the station shows it: "2026-10-30 14:31 ADT" in its time zone,
 * the abbreviation telling summer from winter time (the night the clocks go
 * back, 01:30 happens twice). Without a known time zone: UTC.
 */
export function localTime(ms, timeZone) {
  const format = (timeZone && formatOf(timeZone)) || formatOf('UTC');
  const parts = new Map(format.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const zone = timeZone && formatOf(timeZone) ? parts.get('timeZoneName') : 'UTC';
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')} ${parts.get('hour')}:${parts.get('minute')} ${zone}`;
}

// --- Stations --------------------------------------------------------------------------

/**
 * A station of the API (`/stations` entry) -> `{ code, id, name, province,
 * operating, series }`, or null. `series` keeps the three codes used here.
 */
export function parseStation(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const code = typeof entry.code === 'string' ? stationCode(entry.code) : null;
  if (!code || code !== entry.code || !isStationId(entry.id)) {
    return null;
  }
  const series = new Set();
  for (const s of Array.isArray(entry.timeSeries) ? entry.timeSeries.slice(0, 50) : []) {
    const c = s && typeof s === 'object' ? s.code : undefined;
    if (c === SERIES.OBSERVED || c === SERIES.PREDICTED || c === SERIES.HILO) {
      series.add(c);
    }
  }
  return {
    code,
    id: entry.id,
    name: cleanText(entry.officialName) || code,
    alternative: cleanText(entry.alternativeName, 120),
    province: /^[A-Z_]{2,8}$/.test(entry.provinceCode ?? '') ? entry.provinceCode : '',
    operating: entry.operating === true,
    series: [SERIES.OBSERVED, SERIES.PREDICTED, SERIES.HILO].filter((c) => series.has(c)),
  };
}

/** `/stations` -> the stations, without duplicates, bounded. */
export function parseStationList(body) {
  const stations = new Map();
  for (const entry of Array.isArray(body) ? body : []) {
    if (stations.size >= MAX_LIST_ENTRIES) {
      break;
    }
    const station = parseStation(entry);
    if (station && !stations.has(station.code)) {
      stations.set(station.code, station);
    }
  }
  return [...stations.values()];
}

/** A notice of the station, bounded: cut on a word, with "…" when longer. */
function notice(value) {
  const text = cleanText(value, 2000);
  if (text.length <= 300) {
    return text;
  }
  const cut = text.slice(0, 299);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 200))}…`;
}

/** `/stations/<id>/metadata` -> `{ timeZone, status, notice: { en, fr } }`. */
export function parseMetadata(body) {
  const status = ['OK', 'DELAY', 'MAINTENANCE', 'INVESTIGATION', 'OFFLINE'].includes(body?.status)
    ? body.status
    : null;
  return {
    timeZone: timeZoneOf(body?.timeZoneCode),
    status,
    notice: { en: notice(body?.publicNotificationEn), fr: notice(body?.publicNotificationFr) },
  };
}

/** The stations whose code, name or other names hold every word of the query. */
export function searchStations(list, query) {
  const words = searchable(query).split(' ').filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  return list.filter((s) => {
    const haystack = ` ${searchable(`${s.code} ${s.name} ${s.alternative} ${s.province}`)} `;
    return words.every((w) => haystack.includes(w));
  });
}

// --- Time series ----------------------------------------------------------------------------

/**
 * `/stations/<id>/data` -> `[{ t, v, qc }]` sorted by time, one point per
 * instant, levels plausible only, dates inside [from, to] (a point outside
 * the window asked is not believed), at most MAX_POINTS (the first ones).
 * `qc`: 1 good, 2 not evaluated, 3 questionable.
 */
export function parsePoints(body, from, to) {
  const points = new Map();
  for (const entry of Array.isArray(body) ? body : []) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const t = parseTime(entry.eventDate);
    const v = level(entry.value);
    if (!Number.isFinite(t) || v === null || t < from || t > to || points.has(t)) {
      continue;
    }
    const qc = ['1', '2', '3'].includes(entry.qcFlagCode) ? Number(entry.qcFlagCode) : 0;
    points.set(t, { t, v, qc });
  }
  return [...points.values()].sort((a, b) => a.t - b.t).slice(0, MAX_POINTS);
}

/** The level of the curve at `t`, linear between its two neighbours; null outside or across a gap. */
export function interpolate(curve, t) {
  if (!Array.isArray(curve) || curve.length === 0 || !Number.isFinite(t)) {
    return null;
  }
  let lo = 0;
  let hi = curve.length - 1;
  if (t < curve[lo].t || t > curve[hi].t) {
    return null;
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].t <= t) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const a = curve[lo];
  const b = curve[hi];
  if (a.t === t) {
    return a.v;
  }
  if (b.t === t) {
    return b.v;
  }
  if (b.t - a.t > MAX_CURVE_GAP) {
    return null;
  }
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/**
 * The point of the curve in force at `t`: the last one at or before it, if
 * less than 30 minutes old (one every 15 minutes). The predicted level is
 * published at this pace, not every minute (its history stays small).
 */
export function curveStep(curve, t) {
  let found = null;
  for (const p of Array.isArray(curve) ? curve : []) {
    if (p.t > t) {
      break;
    }
    found = p;
  }
  return found && t - found.t < 30 * 60_000 ? found : null;
}

/**
 * The high and low tides: the API gives their times and heights, not which
 * is which. A tide higher than both its neighbours is a high tide, lower
 * than both a low tide. At the ends (one neighbour), or when the neighbours
 * disagree, the prediction curve decides (the level an hour before and after);
 * without it, the tide is left out rather than guessed.
 */
export function classifyExtremes(points, curve = []) {
  const extremes = [];
  for (const [i, p] of points.entries()) {
    const prev = points[i - 1];
    const next = points[i + 1];
    let kind = null;
    if (prev && next) {
      if (p.v > prev.v && p.v > next.v) {
        kind = KINDS.HIGH;
      } else if (p.v < prev.v && p.v < next.v) {
        kind = KINDS.LOW;
      }
    }
    if (kind === null) {
      const before = interpolate(curve, p.t - 60 * 60_000);
      const after = interpolate(curve, p.t + 60 * 60_000);
      if (before !== null && after !== null) {
        if (p.v > before && p.v > after) {
          kind = KINDS.HIGH;
        } else if (p.v < before && p.v < after) {
          kind = KINDS.LOW;
        }
      } else if (prev && !next) {
        kind = p.v > prev.v ? KINDS.HIGH : p.v < prev.v ? KINDS.LOW : null;
      } else if (next && !prev) {
        kind = p.v > next.v ? KINDS.HIGH : p.v < next.v ? KINDS.LOW : null;
      }
    }
    if (kind) {
      extremes.push({ t: p.t, v: p.v, kind });
    }
  }
  return extremes.slice(0, MAX_EXTREMES);
}

/** The next tide of a kind after `now`, or null. */
export const nextExtreme = (extremes, kind, now) =>
  (extremes ?? []).find((e) => e.kind === kind && e.t > now) ?? null;

/** The last observation, if recent enough to publish: not older than 2 h, not questionable. */
export function freshObservation(obs, now) {
  return obs &&
    Number.isFinite(obs.t) &&
    obs.t <= now + ABERRANT_FUTURE &&
    now - obs.t <= OBSERVATION_STALE &&
    obs.qc !== 3
    ? obs
    : null;
}

/** Whole minutes until `t` (rounded up: 30 s left is 1 minute, 0 at the tide). */
export const minutesUntil = (t, now) => Math.max(0, Math.ceil((t - now) / 60_000));

// --- Gladys devices and states ----------------------------------------------------------------

const height = (name) => ({
  name,
  category: CAT.LEVEL_SENSOR,
  type: TYPES.LEVEL_SENSOR.LIQUID_DEPTH,
  unit: UNITS.M,
  min: LEVEL_MIN,
  max: LEVEL_MAX,
});
const text = (name) => ({
  name,
  category: CAT.TEXT,
  type: TYPES.TEXT.TEXT,
  min: 0,
  max: 0,
  keep_history: false,
});
const minutes = (name) => ({
  name,
  category: CAT.DURATION,
  type: TYPES.DURATION.INTEGER,
  unit: UNITS.MINUTES,
  min: 0,
  max: 7 * 24 * 60,
  keep_history: false,
});

/**
 * Every feature this integration can publish, in a fixed order. Units of the
 * core only (DEVICE_FEATURE_UNITS_BY_CATEGORY): metres for the levels,
 * minutes for the countdowns.
 */
export const FEATURE_DEFS = new Map([
  [FEATURES.PREDICTED, { ...height('Predicted water level (m)'), keep_history: true }],
  [FEATURES.OBSERVED, { ...height('Observed water level (m)'), keep_history: true }],
  [FEATURES.OBSERVED_AT, text('Observed at (station time)')],
  [
    FEATURES.SURGE,
    { ...height('Observed minus predicted (m)'), min: -20, max: 20, keep_history: true },
  ],
  [FEATURES.NEXT_HIGH_HEIGHT, { ...height('Next high tide height (m)'), keep_history: false }],
  [FEATURES.NEXT_HIGH_TIME, text('Next high tide (station time)')],
  [FEATURES.NEXT_HIGH_MINUTES, minutes('Minutes to the next high tide')],
  [FEATURES.NEXT_LOW_HEIGHT, { ...height('Next low tide height (m)'), keep_history: false }],
  [FEATURES.NEXT_LOW_TIME, text('Next low tide (station time)')],
  [FEATURES.NEXT_LOW_MINUTES, minutes('Minutes to the next low tide')],
]);

/** The feature keys a station can have, from its time series. */
export function keysOf(station) {
  const keys = new Set();
  const series = new Set(station?.series ?? []);
  if (series.has(SERIES.PREDICTED)) {
    keys.add(FEATURES.PREDICTED);
  }
  if (series.has(SERIES.OBSERVED)) {
    keys.add(FEATURES.OBSERVED);
    keys.add(FEATURES.OBSERVED_AT);
    if (series.has(SERIES.PREDICTED)) {
      keys.add(FEATURES.SURGE);
    }
  }
  if (series.has(SERIES.HILO)) {
    for (const key of [
      FEATURES.NEXT_HIGH_HEIGHT,
      FEATURES.NEXT_HIGH_TIME,
      FEATURES.NEXT_HIGH_MINUTES,
      FEATURES.NEXT_LOW_HEIGHT,
      FEATURES.NEXT_LOW_TIME,
      FEATURES.NEXT_LOW_MINUTES,
    ]) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * The current values of a station: only what is known and current. A value
 * missing is left out (never a 0): a silent station publishes nothing new.
 *   data: { extremes, curve, obs }
 */
export function valuesOf(station, data, now) {
  const values = new Map();
  const tz = station.timeZone ?? null;
  const step = curveStep(data?.curve, now);
  if (step) {
    values.set(FEATURES.PREDICTED, { state: round(step.v, 3) });
  }
  const obs = freshObservation(data?.obs, now);
  if (obs) {
    values.set(FEATURES.OBSERVED, { state: round(obs.v, 3) });
    values.set(FEATURES.OBSERVED_AT, { text: localTime(obs.t, tz) });
    const then = interpolate(data?.curve, obs.t);
    if (then !== null) {
      values.set(FEATURES.SURGE, { state: round(obs.v - then, 3) });
    }
  }
  for (const [kind, keys] of [
    [KINDS.HIGH, [FEATURES.NEXT_HIGH_HEIGHT, FEATURES.NEXT_HIGH_TIME, FEATURES.NEXT_HIGH_MINUTES]],
    [KINDS.LOW, [FEATURES.NEXT_LOW_HEIGHT, FEATURES.NEXT_LOW_TIME, FEATURES.NEXT_LOW_MINUTES]],
  ]) {
    const next = nextExtreme(data?.extremes, kind, now);
    if (next) {
      values.set(keys[0], { state: round(next.v, 3) });
      values.set(keys[1], { text: localTime(next.t, tz) });
      values.set(keys[2], { state: minutesUntil(next.t, now) });
    }
  }
  return values;
}

export const idsOf = (gladys, code) => gladys.externalIds(DEVICE_TYPE, code);

/** "Halifax (00490)". */
export const labelOf = (station) =>
  `${station.name || station.code} (${station.code})`.slice(0, 120);

/**
 * The Gladys device of a station. `keys` are the feature keys to declare:
 * the ones of its time series, plus every one declared before (a feature that
 * disappears from a device makes the core mark it changed, and "Update" would
 * delete its history), in the fixed order of FEATURE_DEFS.
 */
export function deviceOf(gladys, station, keys) {
  const ids = idsOf(gladys, station.code);
  return {
    name: labelOf(station),
    external_id: ids.device,
    // The integration reads the API at its own pace: Gladys has nothing to poll.
    should_poll: false,
    features: [...FEATURE_DEFS.entries()]
      .filter(([key]) => keys.has(key))
      .map(([key, def]) => ({
        name: def.name,
        external_id: ids.feature(key),
        category: def.category,
        type: def.type,
        ...(def.unit ? { unit: def.unit } : {}),
        min: def.min,
        max: def.max,
        read_only: true,
        has_feedback: false,
        keep_history: def.keep_history,
      })),
  };
}

/** The states of a station, for publishChangedStates. */
export function statesOf(gladys, station, data, now) {
  const ids = idsOf(gladys, station.code);
  return [...valuesOf(station, data, now).entries()].map(([key, value]) => ({
    device_feature_external_id: ids.feature(key),
    ...value,
  }));
}
