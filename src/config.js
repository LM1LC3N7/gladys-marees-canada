// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized so
// the rest of the code never deals with strings or `undefined`.
// -----------------------------------------------------------------------------

import { MAX_POLL_MINUTES, MAX_STATIONS, MIN_POLL_MINUTES } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest
// (test/manifest.test.js checks it).
export const DEFAULT_CONFIG = {
  stations: '',
  poll_interval: 10,
};

/**
 * A station code of the Canadian Hydrographic Service: 5 digits ("00490").
 * "490" is "00490" (the leading zeros are often dropped); anything else is
 * refused.
 */
export function stationCode(value) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]{1,5}$/.test(text)) {
    return null;
  }
  const code = text.padStart(5, '0');
  return code === '00000' ? null : code;
}

/** "Rivière-du-Loup" -> "riviere du loup": lower case, no accents, words only. */
export function searchable(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * "00490, 7120; 03250" -> the codes (separated by `,`, `;`, spaces or line
 * breaks), without duplicates, and the entries that are not a code (shown in
 * the status, never used).
 */
export function parseStations(text) {
  const codes = [];
  const invalid = [];
  for (const entry of String(text ?? '').split(/[,;\s]+/)) {
    const value = entry.trim().slice(0, 40);
    if (!value) {
      continue;
    }
    const code = stationCode(value);
    if (code) {
      if (!codes.includes(code)) {
        codes.push(code);
      }
    } else if (invalid.length < 5) {
      invalid.push(value);
    }
  }
  return { codes, invalid };
}

const number = (value, fallback, min, max) => {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  return value !== '' && Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.round(n)))
    : fallback;
};

export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const { codes, invalid } = parseStations(source.stations ?? DEFAULT_CONFIG.stations);
  return {
    codes: codes.slice(0, MAX_STATIONS),
    dropped: Math.max(0, codes.length - MAX_STATIONS),
    invalid,
    pollMinutes: number(
      source.poll_interval,
      DEFAULT_CONFIG.poll_interval,
      MIN_POLL_MINUTES,
      MAX_POLL_MINUTES,
    ),
  };
}
