// -----------------------------------------------------------------------------
// Endpoints, pacing, bounds and the keys users store (manifest keys, device
// type, feature keys): the keys are forever, never rename them.
// -----------------------------------------------------------------------------

/**
 * The IWLS API (Integrated Water Level System) of the Canadian Hydrographic
 * Service (Fisheries and Oceans Canada). Public, no account. Published limits
 * per client (IP): 3 requests per second, 30 per minute. The answers carry
 * neither ETag nor Last-Modified (`Cache-Control: no-store`): no conditional
 * request is possible, so the windows asked are kept small instead.
 */
export const API_URL = 'https://api-iwls.dfo-mpo.gc.ca/api/v1';
export const API_HOST = 'api-iwls.dfo-mpo.gc.ca';

export const USER_AGENT =
  'gladys-marees-canada (+https://github.com/LM1LC3N7/gladys-marees-canada)';

/** One HTTP call. */
export const HTTP_TIMEOUT = 20_000;

/**
 * One request at a time, never two closer than this: at most 10 a minute, a
 * third of the 30 the API allows per address (several installations may share
 * one address).
 */
export const REQUEST_GAP = 6_000;

/** The most an answer may weigh. */
export const MAX_SMALL_BODY = 256 * 1024; // a station, its metadata, the high and low tides
export const MAX_SERIES_BODY = 1024 * 1024; // 2 days of predictions every 15 min: about 30 KB
export const MAX_LIST_BODY = 4 * 1024 * 1024; // every station of Canada: about 0.9 MB

/** The time series codes of the API. */
export const SERIES = {
  OBSERVED: 'wlo', // water level, official value (observations)
  PREDICTED: 'wlp', // water level predictions
  HILO: 'wlp-hilo', // high and low tide predictions
};

/** At most this many stations. */
export const MAX_STATIONS = 20;

/** The station list kept for the search: more entries are dropped. */
export const MAX_LIST_ENTRIES = 3000;

/** Points kept per station (predictions every 15 min over 51 h: 205). */
export const MAX_POINTS = 400;
/** High and low tides kept per station (85 h: about 7 a day). */
export const MAX_EXTREMES = 40;

/** How often the integration checks what is due (and fires the tide events). */
export const TICK = 30_000;

/** The observations: read every `poll_interval` minutes (5 to 60). */
export const MIN_POLL_MINUTES = 5;
export const MAX_POLL_MINUTES = 60;

/** Two reads of the observations never closer than this (the test button). */
export const MIN_READ_GAP = 60_000;

/** The station (code -> id, name, time zone): read again after this. */
export const META_TTL = 7 * 24 * 60 * 60_000;
/** A station code the API does not know: asked again after this. */
export const UNKNOWN_RETRY = 24 * 60 * 60_000;
/** A station read that failed: tried again after 2 minutes, doubling up to this. */
export const META_RETRY = 60 * 60_000;
export const RETRY_MIN = 2 * 60_000;
/** A station id the API refuses (404, 400): the station read again, once a day at most. */
export const ID_RECHECK = 24 * 60 * 60_000;

/** The predictions: read again after this, or when less than PREDICTION_MIN_AHEAD is left. */
export const PREDICTION_TTL = 6 * 60 * 60_000;
export const PREDICTION_MIN_AHEAD = 24 * 60 * 60_000;
/** A prediction read that failed: tried again after 2 minutes, doubling up to this. */
export const PREDICTION_RETRY = 30 * 60_000;
/** The windows asked: high and low tides 13 h back to 72 h ahead, the curve 3 h back to 48 h ahead. */
export const HILO_BEFORE = 13 * 60 * 60_000;
export const HILO_AHEAD = 72 * 60 * 60_000;
export const CURVE_BEFORE = 3 * 60 * 60_000;
export const CURVE_AHEAD = 48 * 60 * 60_000;
/** Two points of the curve further apart than this are not interpolated. */
export const MAX_CURVE_GAP = 2 * 60 * 60_000;

/** An observation older than this is not published (the station is silent). */
export const OBSERVATION_STALE = 2 * 60 * 60_000;
/** The first read of the observations asks this far back. */
export const OBSERVATION_BACK = 2 * 60 * 60_000;
/** A date this far ahead of the clock, or before 2000, is aberrant. */
export const ABERRANT_FUTURE = 15 * 60_000;
export const OLDEST_BELIEVED = Date.parse('2000-01-01T00:00:00Z');

/** Plausible water levels (m, chart datum): anything outside is a fault. */
export const LEVEL_MIN = -20;
export const LEVEL_MAX = 100;

/** An unchanged value is re-sent this often, so Gladys keeps it recent. */
export const HEARTBEAT = 30 * 60_000;
/** The states are published at most this often (the countdowns move every minute). */
export const PUBLISH_GAP = 60_000;

/** A 429: never shorter than a minute, never longer than 6 hours. */
export const LIMITED_MIN = 60_000;
export const LIMITED_MAX = 6 * 60 * 60_000;
/** A 429 without Retry-After: 5 minutes, doubling, up to 6 hours. */
export const LIMITED_BASE = 5 * 60_000;

/** A 5xx or a network failure: the round stops after this many in a row (host down). */
export const MAX_FAILURES_IN_A_ROW = 3;

/** The tide events: "minutes before" a high or low tide a scene can wait for. */
export const LEADS = [0, 15, 30, 60, 120, 180];
/** A tide event is sent at most this late (a container asleep, Gladys away); later, dropped. */
export const EVENT_LATE_MAX = 10 * 60_000;
/** One event per tide and lead: another tide of the same kind is at least this far. */
export const SAME_TIDE = 3 * 60 * 60_000;
/** Scene events Gladys did not take: kept at most this many. */
export const MAX_PENDING_EVENTS = 50;

/** The test button answers within this, with what is known if needed. */
export const TEST_DEADLINE = 50_000;

/** The station list (search): kept this long in memory; a failure is retried after RETRY. */
export const LIST_TTL = 24 * 60 * 60_000;
export const LIST_RETRY = 5 * 60_000;

/** The state file: a read or a write that takes longer is given up (a frozen /data). */
export const STORE_TIMEOUT = 5_000;

/** The configuration could not be read from Gladys: tried again after 1 minute, doubling up to 30. */
export const CONFIG_RETRY_MIN = 60_000;
export const CONFIG_RETRY_MAX = 30 * 60_000;

/** The container clock is told off when the `Date` of the API differs by more than this. */
export const CLOCK_SKEW_NOTE = 5 * 60_000;

/** The device type of the external ids (`ext:<selector>:station:<code>`). */
export const DEVICE_TYPE = 'station';

/** Feature keys (part of the external ids: forever). */
export const FEATURES = {
  PREDICTED: 'predicted-level',
  OBSERVED: 'observed-level',
  OBSERVED_AT: 'observed-at',
  SURGE: 'observed-minus-predicted',
  NEXT_HIGH_HEIGHT: 'next-high-height',
  NEXT_HIGH_TIME: 'next-high-time',
  NEXT_HIGH_MINUTES: 'minutes-to-high',
  NEXT_LOW_HEIGHT: 'next-low-height',
  NEXT_LOW_TIME: 'next-low-time',
  NEXT_LOW_MINUTES: 'minutes-to-low',
};

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
  SEARCH: 'search_stations',
};

/** Manifest `scene_triggers` keys. */
export const SCENE_TRIGGERS = {
  TIDE: 'tide_coming',
};

/** Tide kinds (the `kind` filter of the trigger). */
export const KINDS = {
  HIGH: 'high',
  LOW: 'low',
};
