// -----------------------------------------------------------------------------
// The state that must survive a restart of the container, in one JSON file
// under /data (the one writable volume): the 429 pause, the instant of every
// last try (a restart loop never reads faster), the stations, their
// predictions and last observation, the tides already announced, the scene
// events Gladys did not take yet and the features each device ever declared.
//
// The file is data from a previous run, not trusted: every code and id is
// checked, every number bounded, and nothing of it is ever used as an object
// key (Maps only). A file that cannot be read is never taken for an empty
// one: the integration then keeps it untouched (no save) until it can read it.
// -----------------------------------------------------------------------------

import { constants } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stationCode } from './config.js';
import { isStationId } from './client.js';
import {
  KINDS,
  LEADS,
  LIMITED_MAX,
  MAX_EXTREMES,
  MAX_PENDING_EVENTS,
  MAX_POINTS,
  MAX_STATIONS,
  OLDEST_BELIEVED,
  SCENE_TRIGGERS,
  SERIES,
} from './constants.js';
import { FEATURE_DEFS, cleanText, level, timeZoneOf } from './model.js';

/** A storage in memory (tests, and the fallback). */
export function memoryStorage(initial) {
  let value = initial;
  return {
    load: async () => value,
    save: async (next) => {
      value = next;
    },
  };
}

/** A state file that is not valid JSON: it will never become readable by itself. */
export class CorruptStateError extends Error {
  constructor(cause) {
    super('state file corrupt', { cause });
    this.name = 'CorruptStateError';
  }
}

/**
 * A JSON file, asynchronous (a frozen /data never freezes the process; the
 * caller bounds each call in time), written atomically (a fresh .tmp file,
 * then a rename). A missing file is a first start (undefined). Anything but
 * a regular file, or a file that cannot be read, throws: the caller then never
 * overwrites it. A file that is not JSON throws a CorruptStateError: the
 * caller sets it aside (`quarantine`, renamed `.bad`) and starts afresh.
 */
export function fileStorage(path) {
  return {
    async load() {
      let text;
      try {
        const info = await stat(path);
        if (!info.isFile()) {
          throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' });
        }
        text = await readFile(path, {
          encoding: 'utf8',
          flag: constants.O_RDONLY | constants.O_NONBLOCK,
        });
      } catch (err) {
        if (err.code === 'ENOENT') {
          return undefined;
        }
        throw new Error(`state file unreadable (${err.code ?? 'error'})`, { cause: err });
      }
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new CorruptStateError(err);
      }
    },
    async quarantine() {
      await rename(path, `${path}.bad`);
    },
    async save(value) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      // A fresh file (`wx`): never through whatever sat at its place (a FIFO
      // would block the write).
      await rm(tmp, { force: true });
      await writeFile(tmp, JSON.stringify(value), { flag: 'wx' });
      await rename(tmp, path);
    },
  };
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v) => (Array.isArray(v) ? v : []);
/** A past wall instant: a date ahead of the clock is not believed (taken as "now"). */
const past = (v, now) => {
  const n = finite(v);
  if (n === null || n < OLDEST_BELIEVED) {
    return 0;
  }
  return Math.min(n, now);
};

export const emptyState = () => ({
  pause: { until: 0, streak: 0 },
  stations: new Map(),
  data: new Map(),
  tries: new Map(),
  known: new Map(),
  fired: new Map(),
  pending: [],
});

function* pairs(value, max) {
  let count = 0;
  for (const pair of list(value)) {
    if (count >= max) {
      return;
    }
    if (Array.isArray(pair) && pair.length === 2) {
      count += 1;
      yield pair;
    }
  }
}

const exactCode = (v) => (typeof v === 'string' && stationCode(v) === v ? v : null);

const station = (code, s) => {
  if (!s || typeof s !== 'object' || !isStationId(s.id)) {
    return null;
  }
  const series = list(s.series).filter((c) => Object.values(SERIES).includes(c));
  return {
    code,
    id: s.id,
    name: cleanText(s.name) || code,
    alternative: cleanText(s.alternative, 120),
    province: /^[A-Z_]{2,8}$/.test(s.province ?? '') ? s.province : '',
    operating: s.operating === true,
    series: [...new Set(series)],
    timeZone: timeZoneOf(s.timeZone),
    status: ['OK', 'DELAY', 'MAINTENANCE', 'INVESTIGATION', 'OFFLINE'].includes(s.status)
      ? s.status
      : null,
    notice: { en: cleanText(s.notice?.en, 300), fr: cleanText(s.notice?.fr, 300) },
  };
};

const points = (value, max) => {
  const out = [];
  let last = -Infinity;
  for (const p of list(value).slice(0, max)) {
    const t = finite(p?.t);
    const v = level(p?.v);
    if (t === null || t < OLDEST_BELIEVED || v === null || t <= last) {
      continue;
    }
    last = t;
    out.push({ t, v, qc: [0, 1, 2, 3].includes(p?.qc) ? p.qc : 0 });
  }
  return out;
};

const data = (d, now) => {
  const curve = points(d?.curve, MAX_POINTS).map(({ t, v }) => ({ t, v }));
  const obs = points(d?.obs ? [d.obs] : [], 1)[0] ?? null;
  return {
    extremes: extremesOf(d?.extremes),
    curve,
    // The instant of the predictions read: a date ahead of the clock is "now".
    predAt: past(d?.predAt, now),
    obs: obs && obs.t <= now + 15 * 60_000 ? obs : null,
    // The curve was asked and none came (a station without a 15-minute curve).
    noCurve: d?.noCurve === true,
    // High and low tides the integration could not tell apart (left out).
    unclassified: Number.isInteger(d?.unclassified)
      ? Math.min(MAX_EXTREMES, Math.max(0, d.unclassified))
      : 0,
  };
};

/** The high and low tides kept in order, each with its kind. */
function extremesOf(value) {
  const out = [];
  let last = -Infinity;
  for (const e of list(value).slice(0, MAX_EXTREMES)) {
    const t = finite(e?.t);
    const v = level(e?.v);
    if (t === null || t < OLDEST_BELIEVED || v === null || t <= last) {
      continue;
    }
    if (e.kind !== KINDS.HIGH && e.kind !== KINDS.LOW) {
      continue;
    }
    last = t;
    out.push({ t, v, kind: e.kind });
  }
  return out;
}

/** The kinds of tries kept: `meta`, `pred`, `obs`, then `:<code>`. */
const TRY_KEY = /^(meta|pred|obs):[0-9]{5}$/;
const firedKeyOk = (key) => {
  const [code, kind, lead, more] = String(key).split('|');
  return (
    more === undefined &&
    exactCode(code) !== null &&
    (kind === KINDS.HIGH || kind === KINDS.LOW) &&
    LEADS.map(String).includes(lead)
  );
};

/**
 * The persisted state, checked: anything malformed is dropped, a date ahead
 * of the clock is taken as now (never a longer wait: a shorter one, never).
 */
export function loadState(raw, now) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') {
    return state;
  }
  const until = finite(raw.pause?.until);
  const streak = finite(raw.pause?.streak);
  state.pause = {
    until: until !== null && until > now ? Math.min(until, now + LIMITED_MAX) : 0,
    streak: streak !== null && streak >= 0 ? Math.min(10, Math.round(streak)) : 0,
  };
  for (const [code, s] of pairs(raw.stations, MAX_STATIONS * 3)) {
    const c = exactCode(code);
    const value = c ? station(c, s) : null;
    if (value) {
      state.stations.set(c, value);
    }
  }
  for (const [code, d] of pairs(raw.data, MAX_STATIONS * 3)) {
    const c = exactCode(code);
    if (c) {
      state.data.set(c, data(d, now));
    }
  }
  for (const [key, t] of pairs(raw.tries, MAX_STATIONS * 9)) {
    if (typeof key === 'string' && TRY_KEY.test(key) && t && typeof t === 'object') {
      const at = past(t.at, now);
      if (at > 0) {
        state.tries.set(key, {
          at,
          ok: t.ok === true,
          unknown: t.unknown === true,
          fails: Number.isInteger(t.fails) ? Math.min(20, Math.max(0, t.fails)) : 0,
          idSuspect: t.idSuspect === true,
          recheck: t.recheck === true,
          mono: null,
        });
      }
    }
  }
  for (const [code, keys] of pairs(raw.known, MAX_STATIONS * 3)) {
    const c = exactCode(code);
    if (c) {
      state.known.set(c, new Set(list(keys).filter((k) => FEATURE_DEFS.has(k))));
    }
  }
  for (const [key, t] of pairs(raw.fired, MAX_STATIONS * 2 * LEADS.length * 2)) {
    const n = finite(t);
    if (firedKeyOk(key) && n !== null && n > OLDEST_BELIEVED) {
      state.fired.set(key, n);
    }
  }
  for (const e of list(raw.pending).slice(-MAX_PENDING_EVENTS)) {
    const at = past(e?.at, now);
    const tideAt = finite(e?.tideAt);
    if (
      e?.key === SCENE_TRIGGERS.TIDE &&
      at > 0 &&
      tideAt !== null &&
      tideAt > OLDEST_BELIEVED &&
      e.data &&
      typeof e.data === 'object'
    ) {
      state.pending.push({ key: e.key, data: pendingData(e.data), at, tideAt });
    }
  }
  return state;
}

/** The data of a pending event: the flat keys of the trigger, primitives only. */
function pendingData(d) {
  const keys = [
    'device',
    'kind',
    'lead',
    'station',
    'station_name',
    'height',
    'tide_time',
    'minutes_left',
    'summary',
    'summary_fr',
  ];
  const out = {};
  for (const key of keys) {
    const v = Object.hasOwn(d, key) ? d[key] : null;
    out[key] =
      typeof v === 'string'
        ? cleanText(v, 300)
        : typeof v === 'number' && Number.isFinite(v)
          ? v
          : null;
  }
  return out;
}

/** The state as JSON (Maps as lists of pairs). */
export function saveState(state) {
  return {
    v: 1,
    pause: { until: state.pause.until, streak: state.pause.streak },
    stations: [...state.stations.entries()],
    data: [...state.data.entries()],
    tries: [...state.tries.entries()].map(([key, t]) => [
      key,
      {
        at: t.at,
        ok: t.ok,
        unknown: t.unknown,
        fails: t.fails ?? 0,
        idSuspect: t.idSuspect === true,
        recheck: t.recheck === true,
      },
    ]),
    known: [...state.known.entries()].map(([code, keys]) => [code, [...keys]]),
    fired: [...state.fired.entries()],
    pending: state.pending,
  };
}
