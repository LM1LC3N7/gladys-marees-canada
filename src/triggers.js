// -----------------------------------------------------------------------------
// The scene events "high (or low) tide in N minutes", from the predicted high
// and low tides of a station. Pure: `now` and the memory of what was sent are
// parameters.
//
// For each predicted tide and each lead of LEADS (0, 15, 30, 60, 120, 180
// minutes), one event when the clock reaches "tide - lead". The scene author
// picks the kind and the lead (the core compares a trigger filter for
// equality). An event is sent at most EVENT_LATE_MAX late (a container that
// was stopped, Gladys away): later, it is dropped, a late alarm being a wrong
// alarm. One event per tide and lead: `fired` keeps, per station, kind and
// lead, the time of the last tide announced; a tide closer than SAME_TIDE to
// it is the same tide (predictions read again move it by a minute or so).
// -----------------------------------------------------------------------------

import { EVENT_LATE_MAX, KINDS, LEADS, SAME_TIDE, SCENE_TRIGGERS } from './constants.js';
import { labelOf, localTime, round } from './model.js';

export const firedKey = (code, kind, lead) => `${code}|${kind}|${lead}`;

const word = {
  [KINDS.HIGH]: { en: 'High tide', fr: 'Pleine mer' },
  [KINDS.LOW]: { en: 'Low tide', fr: 'Basse mer' },
};

const fmt = (value, lang) => {
  const text = String(round(value, 2));
  return lang === 'fr' ? text.replace('.', ',') : text;
};

/** The summaries of an event, in English and French, for `left` minutes to the tide. */
export function summaries({ kind, lead, left, name, height, time }) {
  const inEn = Number(lead) === 0 ? 'now' : `in ${left} min`;
  const inFr = Number(lead) === 0 ? 'maintenant' : `dans ${left} min`;
  const w = word[kind] ?? word[KINDS.HIGH];
  return {
    summary: `${w.en} ${inEn} at ${name}: ${fmt(height, 'en')} m at ${time} (predicted, not for navigation)`,
    summary_fr: `${w.fr} ${inFr} à ${name} : ${fmt(height, 'fr')} m à ${time} (prédiction, pas pour la navigation)`,
  };
}

/** Whole minutes to the tide at `now`, never negative. */
export const minutesLeft = (tideAt, now) => Math.max(0, Math.round((tideAt - now) / 60_000));

/**
 * The events due at `now` for one station. `fired` (Map key -> tide time) is
 * updated in place for the events returned. Each event carries `at`, the
 * instant it was due (tide - lead), and `tideAt`: its lateness is counted
 * from `at`, and its countdown recomputed when it is sent.
 */
export function tideEvents({ station, extremes, now, fired, device }) {
  const events = [];
  for (const tide of extremes ?? []) {
    for (const lead of LEADS) {
      const at = tide.t - lead * 60_000;
      if (now < at || now - at > EVENT_LATE_MAX) {
        continue;
      }
      const key = firedKey(station.code, tide.kind, lead);
      const last = fired.get(key);
      if (last !== undefined && Math.abs(tide.t - last) < SAME_TIDE) {
        continue;
      }
      fired.set(key, tide.t);
      const name = labelOf(station);
      const time = localTime(tide.t, station.timeZone ?? null);
      const left = minutesLeft(tide.t, now);
      const height = round(tide.v, 3);
      events.push({
        key: SCENE_TRIGGERS.TIDE,
        at,
        tideAt: tide.t,
        data: {
          device,
          kind: tide.kind,
          lead: String(lead),
          station: station.code,
          station_name: name,
          height,
          tide_time: time,
          minutes_left: left,
          ...summaries({ kind: tide.kind, lead, left, name, height, time }),
        },
      });
    }
  }
  return events;
}

/** The memory of the tides announced, without the ones older than a day. */
export function pruneFired(fired, now) {
  for (const [key, t] of fired) {
    if (t < now - 24 * 60 * 60_000) {
      fired.delete(key);
    }
  }
}
