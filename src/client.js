// -----------------------------------------------------------------------------
// The calls to the IWLS API: one request at a time, never two closer than
// REQUEST_GAP (the API allows 3 a second and 30 a minute per address), and
// the 429 pause, kept in the persisted state so a restart never shortens it.
//
// The pacing decisions use the monotonic clock; the wall clock only dates
// the pause for /data (a restart) and builds the windows of dates asked.
// -----------------------------------------------------------------------------

import {
  API_HOST,
  API_URL,
  LIMITED_BASE,
  LIMITED_MAX,
  LIMITED_MIN,
  MAX_LIST_BODY,
  MAX_SERIES_BODY,
  MAX_SMALL_BODY,
  REQUEST_GAP,
} from './constants.js';
import { NetworkError, requestJson } from './http.js';

/**
 * A failed call. `kind`:
 *   limited    429, or a pause still running (no call made)
 *   server     5xx
 *   not_found  404
 *   refused    400 (a station id or a window the API refuses)
 *   http       another status
 *   answer     a 2xx that is not the expected JSON
 *   network    DNS, timeout, a body too large...
 * `sent` is true when the request left (a pause sends nothing).
 */
export class IwlsError extends Error {
  constructor(kind, detail = kind, { sent = true } = {}) {
    super(`${API_HOST}: ${detail}`);
    this.name = 'IwlsError';
    this.kind = kind;
    this.sent = sent;
  }
}

/** An IWLS station id: 24 hexadecimal characters (a MongoDB id). */
export const isStationId = (id) => typeof id === 'string' && /^[0-9a-f]{24}$/.test(id);

/** A date for the API: ISO 8601 UTC, to the second ("2026-10-29T21:00:00Z"). */
export const apiDate = (ms) =>
  new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

export class IwlsClient {
  /**
   * pause: `{ until (wall ms), streak }`, shared with the persisted state.
   * onPauseChange: called after the pause changed (the state is saved then).
   */
  constructor({
    baseUrl = API_URL,
    now = Date.now,
    monotonic = () => performance.now(),
    sleep,
    pause = { until: 0, streak: 0 },
    onPauseChange = () => {},
  } = {}) {
    this.baseUrl = baseUrl;
    this.now = now;
    this.monotonic = monotonic;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pause = pause;
    this.onPauseChange = onPauseChange;
    this.usePause(pause);
    // The first request waits a gap too: a container that restarts in a loop
    // (its /data not writable, say) never sends faster than the gap.
    this.lastSent = monotonic();
    this.chain = Promise.resolve();
    /** The `Date` of the API minus the container clock, at the last answer (NaN: unknown). */
    this.skew = NaN;
  }

  /**
   * The pause read back from /data: its end on the monotonic clock is the rest
   * of the wall pause, capped (a date far ahead never pauses longer than 6 h).
   */
  usePause(pause) {
    this.pause = pause;
    const rest = Math.min(LIMITED_MAX, Math.max(0, pause.until - this.now()));
    this.pauseEnd = rest > 0 ? this.monotonic() + rest : 0;
  }

  /** The rest of the pause (ms, monotonic), 0 when none runs. */
  pausedFor(mono = this.monotonic()) {
    return Math.max(0, Math.min(LIMITED_MAX, this.pauseEnd - mono));
  }

  /** The wall time the pause ends (for the status), 0 when none runs. */
  pausedUntil() {
    const left = this.pausedFor();
    return left > 0 ? this.now() + left : 0;
  }

  /** One call after the others (never alongside), REQUEST_GAP after the previous one. */
  get(path, params, options) {
    const run = this.chain.catch(() => {}).then(() => this.send(path, params, options));
    this.chain = run;
    return run;
  }

  async send(path, params = {}, { maxBytes = MAX_SMALL_BODY, accept }) {
    let mono = this.monotonic();
    if (this.pausedFor(mono) > 0) {
      throw new IwlsError('limited', 'paused (429)', { sent: false });
    }
    // A timer may fire a little early (Node truncates its delay to whole
    // ms): the gap is checked again after each wait.
    for (let i = 0; i < 5; i += 1) {
      const wait = this.lastSent + REQUEST_GAP - mono;
      if (wait <= 0) {
        break;
      }
      await this.sleep(Math.min(Math.max(1, Math.ceil(wait)), REQUEST_GAP));
      mono = this.monotonic();
      if (this.pausedFor(mono) > 0) {
        throw new IwlsError('limited', 'paused (429)', { sent: false });
      }
    }
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    this.lastSent = mono;
    let answer;
    try {
      answer = await requestJson(url.toString(), { maxBytes, now: this.now });
    } catch (err) {
      throw err instanceof NetworkError ? new IwlsError('network', err.message) : err;
    }
    const { status, body, retryAfterMs, date } = answer;
    if (Number.isFinite(date)) {
      this.skew = date - this.now();
    }
    if (status === 429) {
      const streak = Math.min(10, (this.pause.streak ?? 0) + 1);
      const ms = Math.min(
        LIMITED_MAX,
        Math.max(LIMITED_MIN, retryAfterMs ?? LIMITED_BASE * 2 ** (streak - 1)),
      );
      this.pauseEnd = this.monotonic() + ms;
      this.pause.until = this.now() + ms;
      this.pause.streak = streak;
      this.onPauseChange();
      throw new IwlsError('limited', 'http 429');
    }
    if (this.pause.streak || this.pause.until) {
      this.pause.until = 0;
      this.pause.streak = 0;
      this.onPauseChange();
    }
    if (status >= 500) {
      throw new IwlsError('server', `http ${status}`);
    }
    if (status === 404) {
      throw new IwlsError('not_found', 'http 404');
    }
    if (status === 400) {
      throw new IwlsError('refused', 'http 400');
    }
    if (status < 200 || status >= 300) {
      throw new IwlsError('http', `http ${status}`);
    }
    if (!accept(body)) {
      throw new IwlsError('answer', 'unexpected answer');
    }
    return body;
  }

  /** The station of a code: `[]` when the API does not know it. */
  stationByCode(code) {
    if (!/^[0-9]{5}$/.test(code)) {
      return Promise.reject(new IwlsError('answer', 'bad station code', { sent: false }));
    }
    return this.get('/stations', { code }, { accept: Array.isArray });
  }

  /** The metadata of a station (time zone, notices). */
  metadata(id) {
    if (!isStationId(id)) {
      return Promise.reject(new IwlsError('answer', 'bad station id', { sent: false }));
    }
    return this.get(`/stations/${id}/metadata`, {}, { accept: isObject });
  }

  /** The points of one time series of a station between two instants. */
  series(id, code, from, to, resolution) {
    if (!isStationId(id)) {
      return Promise.reject(new IwlsError('answer', 'bad station id', { sent: false }));
    }
    return this.get(
      `/stations/${id}/data`,
      {
        'time-series-code': code,
        from: apiDate(from),
        to: apiDate(to),
        ...(resolution ? { resolution } : {}),
      },
      { maxBytes: MAX_SERIES_BODY, accept: Array.isArray },
    );
  }

  /** Every station (the search). */
  stations() {
    return this.get('/stations', {}, { maxBytes: MAX_LIST_BODY, accept: Array.isArray });
  }
}

const isObject = (body) => body !== null && typeof body === 'object' && !Array.isArray(body);
