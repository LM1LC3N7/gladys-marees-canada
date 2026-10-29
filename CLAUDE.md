# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It reads the tide and water level stations of the
Canadian Hydrographic Service (public IWLS API) and publishes one read-only
device per station, plus a scene trigger before a high or low tide.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "429"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
node .github/scripts/cover.mjs            # draws cover.png
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `test` and
`npm audit --omit=dev` on Node 22 and 24, and builds the Docker image: run them
before pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        TidesApp: stations, pacing, devices, states, tide events, status, buttons
src/client.js                     the IWLS API: one request at a time, 6 s apart, the 429 pause
src/model.js                      answers -> stations, points, high/low tides, values (pure)
src/triggers.js                   tide events (pure)
src/store.js                      the state persisted in /data, checked when read back
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/constants.js                  endpoints, pacing, bounds, feature and manifest keys
src/http.js                       fetch with timeout, no redirect, bounded body
src/i18n.js                       status texts, English and French
gladys-assistant-integration.json manifest: name, config_schema, actions, scene_triggers...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
test/fixtures/                    synthetic answers of the IWLS API's shape (.github/scripts/fixtures.mjs); never real CHS Data
test/kit/                         a copy of the clocks of the shared test kit
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
.github/scripts/cover.mjs         draws cover.png with Node alone
```

## Rules

- **No CHS Data in the repository**: the licence does not allow
  redistributing it. Fixtures are synthetic (`.github/scripts/fixtures.mjs`);
  never commit a real answer of the API, even reduced.
- **Not for navigation**: the CHS licence forbids it; every user-facing
  surface (intro, status, test button, trigger summary, docs) says so, and
  the docs carry the notice the licence asks for. Never remove them.
- **External ids are forever**: `station:<5-digit CHS code>`, then the
  feature keys of `FEATURES` (`src/constants.js`), the trigger key
  `tide_coming` and its filter values. Never rename one; never drop a feature
  from a published device (`known` keeps every key ever declared).
- **Never faster than the pacing**: every call goes through `IwlsClient`,
  one at a time, `REQUEST_GAP` apart, honouring the 429 pause. The try of a
  read is written to `/data` before the request; a failure, a restart or a
  reconnection never brings a read forward. Decisions on the monotonic
  clock.
- **Network data is data**: codes and ids are checked, lookups go through
  Maps, numbers through `num()`/`level()`, dates need an offset and must be
  inside the window asked. A missing value is never published as 0. The
  persisted state is checked the same way.
- **Units of the core only** (`DEVICE_FEATURE_UNITS_BY_CATEGORY` of the core's
  `server/utils/constants.js`).
- **Reconnection** (`connected`): the client, the pause and the tries stay;
  the status and the Discovery list are published again.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release); 0.1.0 was
  set by hand once. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM (a test refuses mojibake).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
