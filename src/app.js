// -----------------------------------------------------------------------------
// The integration itself: the stations to read, when each read is due, the
// Gladys devices and states, the tide events, the connection status and the
// two buttons. index.js only wires the SDK handlers to it.
//
// Two loops, every TICK (30 s):
//   - the fast one never waits for the network: it sends the tide events that
//     are due and publishes the values (computed from the predictions kept,
//     so the countdowns move every minute);
//   - the read round, one at a time, reads what is due, station after
//     station, one request at a time (client.js paces them).
//
// Pacing, per station: the station itself (code -> id, name, time zone)
// once a week, the predictions every 6 hours (sooner when less than a day of
// them is left), the observations every `poll_interval` minutes. Decided on
// the monotonic clock; the wall instant of every try is written to /data
// BEFORE the request, so a restart never reads sooner. A failure, a 429 or a
// reconnection never brings a read forward.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { IwlsClient, IwlsError } from './client.js';
import { normalizeConfig, searchable } from './config.js';
import {
  CLOCK_SKEW_NOTE,
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  CURVE_AHEAD,
  CURVE_BEFORE,
  EVENT_LATE_MAX,
  HEARTBEAT,
  HILO_AHEAD,
  HILO_BEFORE,
  ID_RECHECK,
  LIST_RETRY,
  LIST_TTL,
  MAX_EXTREMES,
  MAX_FAILURES_IN_A_ROW,
  MAX_PENDING_EVENTS,
  MAX_STATIONS,
  META_RETRY,
  META_TTL,
  MIN_READ_GAP,
  OBSERVATION_BACK,
  PREDICTION_MIN_AHEAD,
  PREDICTION_RETRY,
  PREDICTION_TTL,
  PUBLISH_GAP,
  RETRY_MIN,
  SERIES,
  STORE_TIMEOUT,
  TEST_DEADLINE,
  TICK,
  UNKNOWN_RETRY,
} from './constants.js';
import { NOT_FOR_NAVIGATION, T, reason } from './i18n.js';
import {
  classifyExtremes,
  deviceOf,
  freshObservation,
  idsOf,
  interpolate,
  keysOf,
  labelOf,
  localTime,
  minutesUntil,
  nextExtreme,
  parseMetadata,
  parsePoints,
  parseStation,
  parseStationList,
  searchStations,
  statesOf,
  valuesOf,
} from './model.js';
import { CorruptStateError, emptyState, loadState, memoryStorage, saveState } from './store.js';
import { minutesLeft, pruneFired, summaries, tideEvents } from './triggers.js';

const defaultTimers = { setInterval, clearInterval, setTimeout, clearTimeout };

/** 1.234 -> "1.23"; "1,23" in French. */
const metres = (value, lang) => {
  const text = (Math.round(value * 100) / 100).toFixed(2);
  return `${lang === 'fr' ? text.replace('.', ',') : text} m`;
};

/** A tick may come a hair early: a retry due within a second is due. */
const TICK_SLACK = 1_000;

const emptyData = () => ({ extremes: [], curve: [], predAt: 0, obs: null });

export class TidesApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'marees-canada' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    storage = memoryStorage(),
    baseUrl,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.storage = storage;
    this.sleep = (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));
    // The state is read from /data by `ready()` (asynchronous, bounded in
    // time). Until then, and while the file cannot be read, nothing is saved:
    // a state file that exists but cannot be read is never taken for an empty
    // one (left untouched, said in the status, read again at the next start).
    this.storeBroken = false;
    this.storeSetAside = false;
    this.loaded = false;
    this.saving = undefined;
    this.stuckWrite = undefined;
    this.dirty = false;
    this.state = emptyState();
    // The client and its pause live as long as the process: a reconnection
    // to Gladys or a new configuration never clears a 429 pause.
    this.client = new IwlsClient({
      ...(baseUrl ? { baseUrl } : {}),
      now,
      monotonic,
      sleep: this.sleep,
      pause: this.state.pause,
      onPauseChange: () => this.save(),
    });
    this.config = normalizeConfig();
    this.generation = 0;
    this.interval = undefined;
    this.round = undefined;
    this.roundGeneration = -1;
    this.lastError = undefined;
    /** code -> IwlsError kind of the last failure of that station alone. */
    this.stationErrors = new Map();
    this.lastDiscovered = undefined;
    this.lastStatus = undefined;
    this.lastPublish = -Infinity;
    this.retryTimer = undefined;
    this.retryDelay = 0;
    this.list = { stations: [], fetched: -Infinity, failed: -Infinity };
  }

  /** `work` within STORE_TIMEOUT, else a rejection (the work goes on, unawaited). */
  bounded(work, what) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = this.timers.setTimeout(
        () => reject(new Error(`${what}: no answer from /data in ${STORE_TIMEOUT / 1000} s`)),
        STORE_TIMEOUT,
      );
    });
    return Promise.race([Promise.resolve().then(work), timeout]).finally(() =>
      this.timers.clearTimeout(timer),
    );
  }

  /**
   * Read the state from /data once (again at the next start while it could not
   * be read). A file that is not JSON is set aside (`.bad`) and the state
   * starts afresh, saved again; any other failure keeps the file untouched.
   */
  async ready() {
    if (this.loaded && !this.storeBroken) {
      return;
    }
    let raw;
    try {
      raw = await this.bounded(() => this.storage.load(), 'state read');
      this.storeBroken = false;
    } catch (err) {
      if (err instanceof CorruptStateError) {
        this.logger.warn('State file corrupt: set aside as .bad, starting afresh');
        try {
          await this.bounded(() => this.storage.quarantine?.(), 'state set aside');
          this.storeBroken = false;
          this.storeSetAside = true;
        } catch (e) {
          this.storeBroken = true;
          this.logger.warn(`State file not set aside, left untouched: ${e.message}`);
        }
      } else {
        this.storeBroken = true;
        this.logger.warn(`State not read, left untouched: ${err.message}`);
      }
    }
    if (!this.loaded || raw) {
      this.state = raw ? loadState(raw, this.now()) : this.state;
      this.client.usePause(this.state.pause);
    }
    this.loaded = true;
  }

  /**
   * Save the state: one write at a time, the writes asked meanwhile merged
   * into the next one, each bounded in time. A write that never ends (a frozen
   * /data) is not stacked with others: nothing more is written until it ends.
   * Resolves when the state asked is written (or given up); never throws.
   */
  save() {
    if (this.storeBroken || !this.loaded) {
      return Promise.resolve();
    }
    this.dirty = true;
    if (!this.saving) {
      this.saving = this.flushSaves().finally(() => {
        this.saving = undefined;
      });
    }
    return this.saving;
  }

  async flushSaves() {
    while (this.dirty && !this.stuckWrite) {
      this.dirty = false;
      const write = Promise.resolve().then(() => this.storage.save(saveState(this.state)));
      try {
        await this.bounded(() => write, 'state write');
      } catch (err) {
        this.logger.warn(`State not saved: ${err.message}`);
        if (/no answer/.test(err.message)) {
          this.stuckWrite = write
            .catch(() => {})
            .finally(() => {
              this.stuckWrite = undefined;
            });
        }
      }
    }
  }

  intervalMs() {
    return this.config.pollMinutes * 60_000;
  }

  /** The time zone the status shows instants in: the first station's, else UTC. */
  zone() {
    for (const code of this.config.codes) {
      const tz = this.state.stations.get(code)?.timeZone;
      if (tz) {
        return tz;
      }
    }
    return null;
  }

  // --- Lifecycle -------------------------------------------------------------------

  /**
   * A (re)connection to Gladys: read the configuration, then start. When
   * Gladys does not give it, an error status, and a new try after 1 minute,
   * then 2, 4... up to 30 minutes, without end.
   */
  async connect(loadConfig) {
    this.cancelRetry();
    const generation = ++this.generation;
    await this.ready();
    let config;
    try {
      config = await loadConfig();
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      this.logger.warn(`Configuration not read: ${err.message}`);
      this.retryDelay = this.retryDelay
        ? Math.min(this.retryDelay * 2, CONFIG_RETRY_MAX)
        : CONFIG_RETRY_MIN;
      this.lastStatus = undefined;
      this.retryTimer = this.timers.setTimeout(() => {
        this.retryTimer = undefined;
        return this.connect(loadConfig).catch((e) =>
          this.logger.warn(`Retry failed: ${e.message}`),
        );
      }, this.retryDelay);
      await this.setStatus(false, T.configFailed(this.now() + this.retryDelay, this.zone()));
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    this.retryDelay = 0;
    await this.start(config);
  }

  cancelRetry() {
    if (this.retryTimer !== undefined) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  async start(raw = {}) {
    this.stop();
    const generation = ++this.generation;
    await this.ready();
    if (generation !== this.generation) {
      return;
    }
    this.config = normalizeConfig(raw);
    // Gladys keeps the status and the Discovery list in memory only: a
    // (re)connection may follow a restart of the core, so both are published
    // again on every start.
    this.lastStatus = undefined;
    this.lastDiscovered = undefined;
    this.lastPublish = -Infinity;
    this.interval = this.timers.setInterval(
      () => this.tick().catch((err) => this.logger.warn(`Tick failed: ${err.message}`)),
      TICK,
    );
    await this.publishDiscovered();
    await this.refreshStatus(generation);
    // The first round runs on its own (it may take a while: one request
    // every few seconds); `this.round` is its promise.
    this.tick().catch((err) => this.logger.warn(`Tick failed: ${err.message}`));
  }

  stop() {
    this.generation += 1;
    this.cancelRetry();
    if (this.interval !== undefined) {
      this.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /** The container stops: the state is written once more (bounded in time). */
  shutdown() {
    this.stop();
    return this.save();
  }

  // --- Pacing ---------------------------------------------------------------------------

  /** The time since the last try of `key` (ms), Infinity when never tried. */
  since(key, mono, now) {
    const t = this.state.tries.get(key);
    if (!t) {
      return Infinity;
    }
    // In this process: the monotonic clock. From /data: the wall clock,
    // never negative (a date ahead was already taken as "now").
    return t.mono !== null ? mono - t.mono : Math.max(0, now - t.at);
  }

  /**
   * A try starts: written to /data BEFORE the request (the write waited for,
   * bounded in time). Returns the previous try, to give it back when nothing
   * was sent (a 429 pause).
   */
  async markTry(key, mono, now) {
    const previous = this.state.tries.get(key);
    this.state.tries.set(key, {
      at: now,
      mono,
      ok: false,
      unknown: false,
      fails: previous?.fails ?? 0,
      idSuspect: false,
      // A read made because the station id was refused: the next such read
      // waits a day (ID_RECHECK).
      recheck: previous?.idSuspect === true,
    });
    await this.save();
    return previous;
  }

  /** A try ends: a failure counts (the next one comes later and later), a success resets. */
  endTry(key, { ok, unknown = false }) {
    const t = this.state.tries.get(key);
    if (t) {
      t.ok = ok;
      t.unknown = unknown;
      t.fails = ok || unknown ? 0 : Math.min(20, (t.fails ?? 0) + 1);
    }
  }

  /** A 429: the try is given back (the pause decides when to read, not the retry delay). */
  giveBack(key, previous) {
    if (previous) {
      this.state.tries.set(key, previous);
    } else {
      this.state.tries.delete(key);
    }
  }

  /** The wait after `fails` failures in a row: 2 minutes, doubling, up to `max`. */
  retryAfter(fails, max) {
    return Math.min(max, RETRY_MIN * 2 ** Math.max(0, Math.min(10, (fails ?? 1) - 1)));
  }

  metaDue(code, mono, now, force = false) {
    const t = this.state.tries.get(`meta:${code}`);
    if (!t) {
      return true;
    }
    const since = this.since(`meta:${code}`, mono, now);
    if (t.unknown) {
      return since >= UNKNOWN_RETRY;
    }
    if (!t.ok) {
      // The test button asks again a minute after the last try.
      return since + TICK_SLACK >= (force ? MIN_READ_GAP : this.retryAfter(t.fails, META_RETRY));
    }
    if (t.idSuspect) {
      // The id refused: looked up again at once (a minute after the last
      // read), then once a day at most while it stays refused.
      return since >= (t.recheck ? ID_RECHECK : MIN_READ_GAP);
    }
    return since >= META_TTL || !this.state.stations.has(code);
  }

  predictionsDue(code, station, mono, now, force = false) {
    if (!station.series.includes(SERIES.PREDICTED) && !station.series.includes(SERIES.HILO)) {
      return false;
    }
    const t = this.state.tries.get(`pred:${code}`);
    if (!t) {
      return true;
    }
    const since = this.since(`pred:${code}`, mono, now);
    if (!t.ok) {
      return (
        since + TICK_SLACK >= (force ? MIN_READ_GAP : this.retryAfter(t.fails, PREDICTION_RETRY))
      );
    }
    if (since >= PREDICTION_TTL) {
      return true;
    }
    if (since < PREDICTION_RETRY) {
      return false;
    }
    const data = this.state.data.get(code) ?? emptyData();
    const last = Math.max(data.curve.at(-1)?.t ?? 0, data.extremes.at(-1)?.t ?? 0);
    return last - now < PREDICTION_MIN_AHEAD;
  }

  observationsDue(code, station, mono, now, force) {
    if (!station.series.includes(SERIES.OBSERVED)) {
      return false;
    }
    const since = this.since(`obs:${code}`, mono, now);
    return since >= (force ? MIN_READ_GAP : this.intervalMs());
  }

  // --- The loops --------------------------------------------------------------------------

  /**
   * Every TICK: a read round unless one is running (started first, it waits
   * for the network), then the fast loop. Resolves when the round is over.
   */
  async tick({ force = false } = {}) {
    const generation = this.generation;
    if (!this.round || this.roundGeneration !== generation) {
      const run = this.readRound(generation, force).finally(() => {
        if (this.round === run) {
          this.round = undefined;
        }
      });
      this.round = run;
      this.roundGeneration = generation;
    }
    const round = this.round;
    await this.fastLoop(generation);
    return round;
  }

  /** Tide events due, then the values (at most once a minute unless `force`). */
  async fastLoop(generation, { force = false } = {}) {
    if (generation !== this.generation) {
      return;
    }
    this.queueTideEvents();
    await this.flushEvents();
    const mono = this.monotonic();
    // A second of slack: the tick of a minute later may come a little early.
    if (force || mono - this.lastPublish >= PUBLISH_GAP - 1_000) {
      this.lastPublish = mono;
      await this.publishStates();
    }
    if (generation === this.generation) {
      await this.refreshStatus(generation);
    }
  }

  /** Read what is due, station after station; never throws. */
  async readRound(generation, force) {
    if (this.client.pausedFor() > 0) {
      // Paused (429): nothing is tried, so no try is spent.
      await this.refreshStatus(generation);
      return;
    }
    let attempted = false;
    let failures = 0;
    let error;
    let changed = false;
    for (const code of this.config.codes) {
      if (generation !== this.generation) {
        return;
      }
      try {
        const result = await this.readStation(code, generation, force);
        changed = result.changed || changed;
        failures = 0;
        // Cleared by a read that came, not by a tick with nothing due (the
        // status would flip between two ticks).
        if (result.read) {
          this.stationErrors.delete(code);
          attempted = true;
        }
      } catch (err) {
        attempted = true;
        const failure =
          err instanceof IwlsError ? err : new IwlsError('answer', String(err?.message));
        this.logger.warn(`Station ${code} not read: ${failure.message}`);
        error = failure;
        if (failure.kind === 'limited') {
          break;
        }
        this.stationErrors.set(code, failure.kind);
        if (failure.kind === 'not_found' || failure.kind === 'refused') {
          // The API no longer knows this station id: the station is read
          // again (code -> id), once a day at most.
          const meta = this.state.tries.get(`meta:${code}`);
          if (meta) {
            meta.idSuspect = true;
          }
        }
        failures = failure.kind === 'network' || failure.kind === 'server' ? failures + 1 : 0;
        if (failures >= MAX_FAILURES_IN_A_ROW) {
          break;
        }
      }
    }
    if (generation !== this.generation) {
      return;
    }
    // A round with nothing due neither clears the last error (the status
    // would flip between two ticks) nor writes /data.
    if (attempted) {
      this.lastError = error;
      this.save();
    }
    // A station that failed may still have been resolved, or read in part.
    await this.publishDiscovered();
    if (changed || error) {
      await this.fastLoop(generation, { force: true });
    } else {
      await this.refreshStatus(generation);
    }
  }

  /**
   * The reads due for one station. Resolves whether something new came.
   * Throws an IwlsError: a 429 at once (nothing more is sent); another
   * failure after the other reads of the station (the predictions failing
   * never keep the observations from being read).
   */
  async readStation(code, generation, force) {
    let changed = false;
    let read = false;
    let failure;
    let mono = this.monotonic();
    let now = this.now();
    if (this.metaDue(code, mono, now, force)) {
      changed = (await this.readMeta(code, mono, now)) || changed;
      read = true;
      if (generation !== this.generation) {
        return { changed, read };
      }
    }
    const station = this.state.stations.get(code);
    if (!station) {
      return { changed, read };
    }
    mono = this.monotonic();
    now = this.now();
    if (this.predictionsDue(code, station, mono, now, force)) {
      failure = await this.readPredictions(code, station, mono, now);
      changed = true;
      read = true;
      if (generation !== this.generation) {
        return { changed, read };
      }
    }
    mono = this.monotonic();
    now = this.now();
    if (this.observationsDue(code, station, mono, now, force)) {
      changed = (await this.readObservations(code, station, mono, now)) || changed;
      read = true;
    }
    if (failure) {
      throw failure;
    }
    return { changed, read };
  }

  /**
   * The station of a code, then its metadata (time zone, notices): the
   * metadata is never blocking. A 429 gives the try back.
   */
  async readMeta(code, mono, now) {
    const key = `meta:${code}`;
    const before = await this.markTry(key, mono, now);
    let body;
    try {
      body = await this.client.stationByCode(code);
    } catch (err) {
      if (err?.kind === 'limited') {
        this.giveBack(key, before);
      } else {
        this.endTry(key, { ok: false });
      }
      throw err;
    }
    // Only the station of this very code (an answer listing others is not it).
    const station = body.map(parseStation).find((s) => s && s.code === code);
    if (!station) {
      this.endTry(key, { ok: false, unknown: true });
      return false;
    }
    const previous = this.state.stations.get(code);
    if (previous && previous.id !== station.id) {
      // Another station behind the same code: its data is not this one's.
      this.state.data.delete(code);
      this.state.tries.delete(`pred:${code}`);
      this.state.tries.delete(`obs:${code}`);
    }
    let meta = {
      timeZone: previous?.timeZone ?? null,
      status: previous?.status ?? null,
      notice: previous?.notice ?? { en: '', fr: '' },
    };
    let ok = true;
    try {
      meta = parseMetadata(await this.client.metadata(station.id));
    } catch (err) {
      if (err?.kind === 'limited') {
        // The station is known; its metadata is asked again 2 minutes after
        // this try (the pause permitting), never an hour later.
        this.state.stations.set(code, { ...station, ...meta });
        this.endTry(key, { ok: false });
        this.state.tries.get(key).fails = 1;
        throw err;
      }
      // The metadata only gives the time zone and the notices: the values go
      // on without them (UTC), asked again after 2 minutes, then more spaced.
      this.logger.warn(`Metadata of ${code} not read: ${err.message}`);
      ok = false;
    }
    this.state.stations.set(code, { ...station, ...meta });
    this.endTry(key, { ok });
    return true;
  }

  /**
   * The high and low tides and the prediction curve. Each is read on its
   * own: one failing never drops the other, an empty answer never drops what
   * is known. The try is "ok" when both came. A 429 gives the try back and
   * is thrown; the other failure is resolved, if any.
   */
  async readPredictions(code, station, mono, now) {
    const key = `pred:${code}`;
    const before = await this.markTry(key, mono, now);
    const data = this.state.data.get(code) ?? emptyData();
    let ok = true;
    let failure;
    let curve = data.curve;
    let noCurve = data.noCurve ?? false;
    let unclassified = data.unclassified ?? 0;
    const limited = (err) => {
      this.giveBack(key, before);
      throw err;
    };
    if (station.series.includes(SERIES.PREDICTED)) {
      const from = now - CURVE_BEFORE;
      const to = now + CURVE_AHEAD;
      try {
        const body = await this.client.series(
          station.id,
          SERIES.PREDICTED,
          from,
          to,
          'FIFTEEN_MINUTES',
        );
        const points = parsePoints(body, from, to).map(({ t, v }) => ({ t, v }));
        if (points.length === 0) {
          // No curve every 15 minutes (yet): what is known is kept, said.
          noCurve = true;
          throw new IwlsError('answer', 'no prediction curve');
        }
        noCurve = false;
        curve = points;
      } catch (err) {
        if (err?.kind === 'limited') {
          limited(err);
        }
        ok = false;
        failure = err;
      }
    }
    let extremes = data.extremes;
    if (station.series.includes(SERIES.HILO)) {
      const from = now - HILO_BEFORE;
      const to = now + HILO_AHEAD;
      try {
        const body = await this.client.series(station.id, SERIES.HILO, from, to);
        const points = parsePoints(body, from, to);
        const tides = classifyExtremes(points, curve);
        if (tides.length === 0) {
          throw new IwlsError('answer', 'no high or low tide');
        }
        unclassified = Math.max(0, Math.min(points.length, MAX_EXTREMES) - tides.length);
        extremes = tides;
      } catch (err) {
        if (err?.kind === 'limited') {
          this.state.data.set(code, { ...data, curve, noCurve });
          limited(err);
        }
        ok = false;
        failure = err;
      }
    }
    this.state.data.set(code, {
      ...data,
      curve,
      extremes,
      noCurve,
      unclassified,
      predAt: ok ? now : data.predAt,
    });
    this.endTry(key, { ok });
    return failure;
  }

  /** The observations since the last one (2 hours back at most). A 429 gives the try back. */
  async readObservations(code, station, mono, now) {
    const key = `obs:${code}`;
    const before = await this.markTry(key, mono, now);
    const data = this.state.data.get(code) ?? emptyData();
    const from = Math.max(now - OBSERVATION_BACK, (data.obs?.t ?? 0) + 1000);
    const to = now + 60_000;
    let body;
    try {
      body = await this.client.series(station.id, SERIES.OBSERVED, from, to);
    } catch (err) {
      if (err?.kind === 'limited') {
        this.giveBack(key, before);
      } else {
        this.endTry(key, { ok: false });
      }
      throw err;
    }
    const points = parsePoints(body, from, to);
    this.endTry(key, { ok: true });
    const last = points.at(-1);
    if (!last || (data.obs && last.t <= data.obs.t)) {
      return false;
    }
    this.state.data.set(code, { ...(this.state.data.get(code) ?? emptyData()), obs: last });
    return true;
  }

  // --- Tide events ------------------------------------------------------------------------------

  queueTideEvents() {
    const now = this.now();
    pruneFired(this.state.fired, now);
    let added = 0;
    for (const code of this.config.codes) {
      const station = this.state.stations.get(code);
      const data = this.state.data.get(code);
      if (!station || !data || data.extremes.length === 0) {
        continue;
      }
      const events = tideEvents({
        station,
        extremes: data.extremes,
        now,
        fired: this.state.fired,
        device: idsOf(this.gladys, code).device,
      });
      for (const event of events) {
        // Dated from the instant it was due, not from now: its lateness counts from there.
        this.state.pending.push(event);
        added += 1;
      }
    }
    if (added > 0) {
      this.state.pending = this.state.pending.slice(-MAX_PENDING_EVENTS);
      this.save();
    }
  }

  /**
   * Send the scene events waiting, in order. One Gladys does not take (down,
   * restarting, rate limit) stays queued and is tried again at the next tick;
   * more than EVENT_LATE_MAX after the instant it was due, it is dropped (a
   * late alarm is a wrong alarm). Its countdown and summaries are those of
   * the instant it is sent.
   */
  async flushEvents() {
    const now = this.now();
    const before = this.state.pending.length;
    this.state.pending = this.state.pending.filter(
      (e) => now - e.at <= EVENT_LATE_MAX && e.at <= now + 60_000,
    );
    let changed = this.state.pending.length !== before;
    while (this.state.pending.length > 0) {
      const [event] = this.state.pending;
      const left = minutesLeft(event.tideAt, this.now());
      const data = {
        ...event.data,
        minutes_left: left,
        ...summaries({
          kind: event.data.kind,
          lead: event.data.lead,
          left,
          name: event.data.station_name,
          height: event.data.height,
          time: event.data.tide_time,
        }),
      };
      try {
        await this.gladys.publishSceneEvent(event.key, data);
      } catch (err) {
        const status = Number(err?.status);
        if (status >= 400 && status < 500 && status !== 429) {
          // Refused for good (the payload, the declaration): retrying would
          // only block the events behind it.
          this.logger.warn(`Scene event ${event.key} refused (http ${status}), dropped`);
          this.state.pending.shift();
          changed = true;
          continue;
        }
        this.logger.warn(`Scene event ${event.key} not sent, kept for later: ${err.message}`);
        break;
      }
      this.state.pending.shift();
      changed = true;
    }
    if (changed) {
      this.save();
    }
  }

  // --- Gladys devices and states ----------------------------------------------------------------

  /** The feature keys of the device the user created for a station. */
  createdKeys(code) {
    const ids = idsOf(this.gladys, code);
    const prefix = `${ids.device}:`;
    const keys = new Set();
    for (const device of this.gladys.devices ?? []) {
      if (device.external_id !== ids.device) {
        continue;
      }
      for (const feature of device.features ?? []) {
        const externalId = String(feature.external_id ?? '');
        if (externalId.startsWith(prefix)) {
          keys.add(externalId.slice(prefix.length));
        }
      }
    }
    return keys;
  }

  /** The devices of the configured stations already resolved. */
  devices() {
    const devices = [];
    let changed = false;
    for (const code of this.config.codes) {
      const station = this.state.stations.get(code);
      if (!station) {
        continue;
      }
      const known = this.state.known.get(code) ?? new Set();
      const size = known.size;
      for (const key of keysOf(station)) {
        known.add(key);
      }
      changed = changed || known.size !== size || !this.state.known.has(code);
      this.state.known.set(code, known);
      const keys = new Set([...known, ...this.createdKeys(code)]);
      const device = deviceOf(this.gladys, station, keys);
      if (device.features.length > 0) {
        devices.push(device);
      }
    }
    if (changed) {
      this.save();
    }
    return devices;
  }

  /** The Discovery tab, published again only when it changed (or on demand). */
  async publishDiscovered({ force = false } = {}) {
    const devices = this.devices();
    const key = JSON.stringify(devices);
    if (!force && key === this.lastDiscovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.lastDiscovered = key;
    } catch (err) {
      this.logger.warn(`publishDiscoveredDevices failed: ${err.message}`);
    }
  }

  /** The current values of the created features, only what changed (plus a heartbeat). */
  async publishStates() {
    const created = new Set();
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        created.add(feature.external_id);
      }
    }
    if (created.size === 0) {
      return;
    }
    const now = this.now();
    const states = [];
    for (const code of this.config.codes) {
      const station = this.state.stations.get(code);
      const data = this.state.data.get(code);
      if (station && data) {
        states.push(...statesOf(this.gladys, station, data, now));
      }
    }
    const wanted = states.filter((s) => created.has(s.device_feature_external_id));
    if (wanted.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(wanted, { heartbeat: HEARTBEAT });
    } catch (err) {
      this.logger.warn(`Publishing the states failed: ${err.message}`);
    }
  }

  /** A device was created: its values now (computed for this instant, never older ones). */
  async deviceCreated() {
    this.lastPublish = this.monotonic();
    await this.publishStates();
  }

  // --- Status --------------------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** What each configured station has now. */
  summary(now = this.now()) {
    const out = {
      predicted: [],
      noPrediction: [],
      observed: [],
      withObserved: [],
      silent: [],
      questionable: [],
      unknown: [],
      notRead: [],
      noCurve: [],
      unclassified: [],
    };
    for (const code of this.config.codes) {
      const station = this.state.stations.get(code);
      if (!station) {
        const t = this.state.tries.get(`meta:${code}`);
        (t?.unknown ? out.unknown : out.notRead).push(code);
        continue;
      }
      const data = this.state.data.get(code) ?? emptyData();
      const name = labelOf(station);
      const predicts =
        station.series.includes(SERIES.PREDICTED) || station.series.includes(SERIES.HILO);
      if (
        interpolate(data.curve, now) !== null ||
        nextExtreme(data.extremes, 'high', now) ||
        nextExtreme(data.extremes, 'low', now)
      ) {
        out.predicted.push(name);
      } else if (predicts && this.state.tries.has(`pred:${code}`)) {
        out.noPrediction.push(name);
      }
      if (data.noCurve) {
        out.noCurve.push(name);
      }
      if (data.unclassified > 0) {
        out.unclassified.push(name);
      }
      if (station.series.includes(SERIES.OBSERVED)) {
        out.withObserved.push(name);
        if (freshObservation(data.obs, now)) {
          out.observed.push(name);
        } else if (data.obs?.qc === 3 && now - data.obs.t <= 2 * 60 * 60_000) {
          out.questionable.push(name);
        } else if (this.state.tries.has(`obs:${code}`)) {
          out.silent.push(name);
        }
      }
    }
    return out;
  }

  notes(summary) {
    const notes = [];
    if (this.config.invalid.length > 0) {
      notes.push(T.invalid(this.config.invalid));
    }
    if (this.config.dropped > 0) {
      notes.push(T.tooMany(MAX_STATIONS));
    }
    if (summary.unknown.length > 0) {
      notes.push(T.unknown(summary.unknown));
    }
    if (summary.notRead.length > 0) {
      notes.push(T.notRead(summary.notRead));
    }
    if (summary.noPrediction.length > 0) {
      notes.push(T.noPrediction(summary.noPrediction));
    }
    if (summary.noCurve.length > 0) {
      notes.push(T.noCurve(summary.noCurve));
    }
    if (summary.unclassified.length > 0) {
      notes.push(T.unclassified(summary.unclassified));
    }
    if (summary.silent.length > 0) {
      notes.push(T.silent(summary.silent));
    }
    if (summary.questionable.length > 0) {
      notes.push(T.questionable(summary.questionable));
    }
    const skew = this.client.skew;
    if (Number.isFinite(skew) && Math.abs(skew) > CLOCK_SKEW_NOTE) {
      notes.push(T.clockSkew(Math.round(Math.abs(skew) / 60_000)));
    }
    if (this.storeBroken) {
      notes.push(T.storeUnreadable);
    }
    if (this.storeSetAside) {
      notes.push(T.storeSetAside);
    }
    return notes;
  }

  join(texts) {
    return {
      en: texts.map((t) => t.en).join(' '),
      fr: texts.map((t) => t.fr).join(' '),
    };
  }

  async refreshStatus(generation = this.generation) {
    if (generation !== this.generation) {
      return;
    }
    if (this.config.codes.length === 0) {
      return this.setStatus(false, this.join([T.noStation, ...this.notes(this.summary())]));
    }
    const summary = this.summary();
    const texts = [];
    const pausedUntil = this.client.pausedUntil();
    if (pausedUntil) {
      texts.push(T.paused(pausedUntil, this.zone()));
    } else if (this.lastError) {
      texts.push(T.failed(reason(this.lastError.kind)));
    }
    texts.push(
      T.ok({
        stations: this.config.codes.length,
        predicted: summary.predicted.length,
        observed: summary.observed.length,
        withObserved: summary.withObserved.length,
        interval: this.config.pollMinutes,
      }),
    );
    texts.push(...this.notes(summary), NOT_FOR_NAVIGATION);
    // Connected: something current to show. Nothing yet, but nothing failed
    // either (the first round runs): connected too.
    const current = summary.predicted.length + summary.observed.length > 0;
    const connected = current || (!this.lastError && !pausedUntil && summary.unknown.length === 0);
    return this.setStatus(connected, this.join(texts));
  }

  // --- The configuration screen buttons -----------------------------------------------------------

  line(code, lang, now) {
    const station = this.state.stations.get(code);
    const fr = lang === 'fr';
    const colon = fr ? ' :' : ':';
    if (!station) {
      const t = this.state.tries.get(`meta:${code}`);
      const failed = this.stationErrors.get(code);
      const why = t?.unknown
        ? fr
          ? 'code inconnu du service'
          : 'code unknown to the service'
        : failed
          ? reason(failed)[lang]
          : fr
            ? 'pas encore lue'
            : 'not read yet';
      return `- ${code}${colon} ${why}`;
    }
    const data = this.state.data.get(code) ?? emptyData();
    const values = valuesOf(station, data, now);
    const tz = station.timeZone;
    const parts = [];
    const predicted = interpolate(data.curve, now);
    if (predicted !== null) {
      parts.push(`${fr ? 'prédit maintenant' : 'predicted now'} ${metres(predicted, lang)}`);
    }
    for (const kind of ['high', 'low']) {
      const next = nextExtreme(data.extremes, kind, now);
      if (next) {
        const word =
          kind === 'high' ? (fr ? 'pleine mer' : 'high tide') : fr ? 'basse mer' : 'low tide';
        parts.push(
          `${word} ${localTime(next.t, tz)} (${metres(next.v, lang)}, ${fr ? 'dans' : 'in'} ${minutesUntil(next.t, now)} min)`,
        );
      }
    }
    if (station.series.includes(SERIES.OBSERVED)) {
      const obs = freshObservation(data.obs, now);
      if (obs) {
        const surge = values.get('observed-minus-predicted');
        parts.push(
          `${fr ? 'observé' : 'observed'} ${metres(obs.v, lang)} ${fr ? 'à' : 'at'} ${localTime(obs.t, tz)}` +
            (surge
              ? ` (${fr ? 'écart à la prédiction' : 'off the prediction by'} ${metres(surge.state, lang)})`
              : ''),
        );
      } else if (data.obs) {
        parts.push(
          fr
            ? `dernière observation ${localTime(data.obs.t, tz)}, trop ancienne ou douteuse : non publiée`
            : `last observation ${localTime(data.obs.t, tz)}, too old or questionable: not published`,
        );
      } else {
        parts.push(fr ? 'aucune observation récente' : 'no recent observation');
      }
    } else {
      parts.push(
        fr ? 'pas de mesure (prédictions seulement)' : 'no measurement (predictions only)',
      );
    }
    if (!tz) {
      parts.push(fr ? 'heures en UTC (fuseau inconnu)' : 'times in UTC (time zone unknown)');
    }
    if (this.stationErrors.has(code)) {
      parts.push(`(${reason(this.stationErrors.get(code))[lang]})`);
    }
    if (parts.length === 0) {
      parts.push(fr ? 'aucune donnée actuelle' : 'no current data');
    }
    const notice = station.notice?.[lang];
    return `- ${labelOf(station)}${station.province ? ` ${station.province}` : ''}${colon} ${parts.join(', ')}${notice ? `\n  ${fr ? 'Avis' : 'Notice'}${colon} ${notice}` : ''}`;
  }

  /** Run `work`, but stop waiting at `deadline` (monotonic). */
  async before(deadline, work) {
    const left = deadline - this.monotonic();
    if (left <= 0) {
      return;
    }
    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.timers.setTimeout(resolve, left);
    });
    try {
      await Promise.race([work(), timeout]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** "Test": read what is due now (observations: unless read less than a minute ago), show every station. */
  async testConnection() {
    const deadline = this.monotonic() + TEST_DEADLINE;
    if (this.config.codes.length > 0) {
      await this.before(deadline, async () => {
        // A round already running is waited for, then one that may read the
        // observations a minute after the last read.
        if (this.round) {
          await this.round;
        }
        await this.tick({ force: true });
      });
    }
    const notes = this.notes(this.summary());
    if (this.config.codes.length === 0) {
      return this.join([T.noStation, ...notes]);
    }
    const now = this.now();
    const out = { en: [], fr: [] };
    const pausedUntil = this.client.pausedUntil();
    for (const lang of ['en', 'fr']) {
      if (pausedUntil) {
        out[lang].push(T.paused(pausedUntil, this.zone())[lang]);
      } else if (this.lastError) {
        out[lang].push(T.failed(reason(this.lastError.kind))[lang]);
      }
      out[lang].push(
        lang === 'fr'
          ? `Stations (observations lues toutes les ${this.config.pollMinutes} min) :`
          : `Stations (observations read every ${this.config.pollMinutes} min):`,
      );
      for (const code of this.config.codes) {
        out[lang].push(this.line(code, lang, now));
      }
      for (const note of notes) {
        out[lang].push(note[lang]);
      }
      out[lang].push(NOT_FOR_NAVIGATION[lang]);
    }
    return { en: out.en.join('\n'), fr: out.fr.join('\n') };
  }

  /** "Search stations": the stations whose code, name or other names match. */
  async search(fields = {}) {
    const query = String(fields?.query ?? '')
      .trim()
      .slice(0, 80);
    if (!searchable(query)) {
      return {
        en: 'Type a few letters of a place (Halifax, Rimouski, Tofino...).',
        fr: "Tapez quelques lettres d'un lieu (Halifax, Rimouski, Tofino…).",
      };
    }
    const mono = this.monotonic();
    const stale = this.list.stations.length === 0 || mono - this.list.fetched >= LIST_TTL;
    // A click may read the list again, never sooner than LIST_RETRY after a
    // failure; the request waits its turn behind the others (one at a time).
    if (stale && mono - this.list.failed >= LIST_RETRY) {
      await this.before(mono + TEST_DEADLINE, async () => {
        try {
          const stations = parseStationList(await this.client.stations());
          if (stations.length === 0) {
            throw new IwlsError('answer', 'empty station list');
          }
          this.list = { stations, fetched: this.monotonic(), failed: -Infinity };
        } catch (err) {
          this.list.failed = this.monotonic();
          this.logger.warn(`Station list not read: ${err.message}`);
        }
      });
    }
    if (this.list.stations.length === 0) {
      const pausedUntil = this.client.pausedUntil();
      return pausedUntil
        ? T.paused(pausedUntil, this.zone())
        : {
            en: 'The station list could not be read: try again in a few minutes.',
            fr: "La liste des stations n'a pas pu être lue : réessayez dans quelques minutes.",
          };
    }
    // Stations that predict or measure first, in service first.
    const matches = searchStations(this.list.stations, query)
      .filter((s) => s.series.length > 0)
      .sort((a, b) => Number(b.operating) - Number(a.operating) || a.code.localeCompare(b.code));
    if (matches.length === 0) {
      return {
        en: `No station matches "${query}".`,
        fr: `Aucune station ne correspond à « ${query} ».`,
      };
    }
    const shown = matches.slice(0, 15);
    const more = matches.length - shown.length;
    const what = (s, lang) => {
      const fr = lang === 'fr';
      const parts = [];
      if (s.series.includes(SERIES.HILO) || s.series.includes(SERIES.PREDICTED)) {
        parts.push(fr ? 'prédictions' : 'predictions');
      }
      if (s.series.includes(SERIES.OBSERVED)) {
        parts.push(
          s.operating
            ? fr
              ? 'mesures'
              : 'measurements'
            : fr
              ? 'mesures (hors service)'
              : 'measurements (out of service)',
        );
      }
      return parts.join(', ');
    };
    const lines = (lang) => [
      ...shown.map(
        (s) => `- ${s.code}: ${s.name}${s.province ? ` (${s.province})` : ''}, ${what(s, lang)}`,
      ),
      ...(more > 0 ? [lang === 'fr' ? `… et ${more} de plus.` : `… and ${more} more.`] : []),
    ];
    return {
      en: ['Copy the code into "Stations":', ...lines('en')].join('\n'),
      fr: ['Copiez le code dans « Stations » :', ...lines('fr')].join('\n'),
    };
  }
}
