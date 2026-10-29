# TODO

## Before announcing

- [ ] Run it in a Gladys 5.1+ in use: the scene trigger (the editor with its
      `devices` select and the two required selects), the values on the
      dashboard. Done on 2026-10-29 in the local test Gladys (sandbox, real
      API, Halifax, Victoria, Rimouski): installation, configuration,
      discovery (10 features each), status, test button; not the scenes.
- [ ] Check the CI on GitHub (Docker build, Node 22 and 24), then the store
      validator once the image is published.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store.
- [ ] Store metadata kept out of the manifest at milestone 1: `countries`
      `["CA"]`, `keywords` tides, marées, water level, niveau d'eau, CHS,
      SHC, Fisheries and Oceans, Pêches et Océans, St. Lawrence,
      Saint-Laurent.

## To confirm (Louis)

- [ ] **The licence of the data is not the Open Government Licence** (the
      candidate list said so): the IWLS API answers under the CHS licence
      agreement (https://www.tides.gc.ca/en/licence-agreement, 2023-08-14):
      not for navigation, no commercial derivative product, a mandatory
      notice on any derivative product. The integration is free and not for
      navigation; the notice is in the docs (en and fr), the README and
      THIRD_PARTY_NOTICES.md, and "not for navigation" in the status, the
      test button, the intro of the configuration and the trigger summaries.
      To decide: is that enough, or should CHS be asked (chsinfo@dfo-mpo.gc.ca)
      before publishing?
- [ ] The high and low tides of `wlp-hilo` come without "high" or "low":
      classified by their neighbours, else by the curve an hour before and
      after, else left out. Checked on Halifax and Victoria (alternating);
      to watch on the stations of the upper St. Lawrence and the Great Lakes,
      where tides are weak or absent.
- [ ] Stations whose curve is not offered every 15 minutes: the read gets
      nothing, the curve known is kept and asked again every 30 minutes, and
      the status says "no current prediction". None met yet; a fallback to
      `SIXTY_MINUTES` could follow if one is reported.

## Decisions

- Fixtures synthetic (review r1, I1): the CHS licence grants access and use,
  not redistribution; the local history was rewritten so that no commit holds
  a real answer.
- `predicted-level` published once per 15-minute point (its history stays
  small); the test button still shows the level interpolated for now.
- The trigger's station field is required: a scene without a station would
  fire for every station.
- Using the integration means accepting the CHS licence (config intro, docs);
  the docs say what to delete if CHS ends it (15 days).

- Version 0.1.0 set by hand (package.json, lock, manifest, image tag).
- SDK `^0.16.0`, the template's, which is the latest published
  (registry `dist-tags.latest`, 2026-10-29).
- Category `environment` only (open-data daily-life feed); `transports`
  `cloud`.
- Station codes only in the configuration (5 digits, `490` read `00490`):
  names are ambiguous across Canada; the Search button gives the codes.
  External ids `station:<code>` (the CHS code, stable), never the API id
  (a database id that may change: re-read weekly, data dropped if it does).
- Reads: one request at a time, 6 s apart (10 a minute at most, a third
  of the 30 allowed per address: several installations may share one). Station and metadata weekly, predictions every 6 hours (sooner
  when less than 24 h are left, never sooner than 30 minutes after a read that came; a failure is retried after 2, 4, 8... minutes up to 30, a 429 gives its try back), observations
  every 5 to 60 minutes (default 10). Windows small: the API offers neither
  ETag nor Last-Modified.
- Pacing on the monotonic clock; the wall instant of each try written to
  `/data` before the request (a date ahead of the clock read back as "now").
  The tide events follow the wall clock (a tide is a wall-clock instant);
  a skew over 5 minutes against the `Date` of the API is said in the status.
- An observation older than 2 hours, or flagged questionable (`qcFlagCode`
  3), is not published; the status names the station. Never a 0.
- Heights in metres above chart datum, as given (no conversion: the API is
  metric). Units of the core only: `m` (level-sensor/liquid-depth), minutes
  (duration/integer), text.
- Tide trigger: leads 0, 15, 30, 60, 120, 180 minutes; one event per tide,
  kind and lead (a tide moved by less than 3 h is the same tide); sent at most
  10 minutes late, else dropped; pending events kept in `/data`.
- The metadata (time zone, notices) and the high and low tides are never
  blocking: without them, UTC times / no next tide, the rest goes on.
- A state file that exists but cannot be read is left untouched and nothing
  is saved (said in the status), never taken for an empty one.
- No house location (`location: true`): finding the nearest station would
  need the home coordinates; the search by place is enough for now.
- The test kit clocks are copied into `test/kit/` (the tests run on GitHub
  CI without `~/code/ref`).
