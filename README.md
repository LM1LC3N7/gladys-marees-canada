# gladys-marees-canada

[Gladys Assistant](https://gladysassistant.com) external integration for the
tides and water levels of the Canadian Hydrographic Service (CHS): predicted
water level, next high and low tides (height, time, minutes left), observed
level and its gap to the prediction, and a scene trigger before a high or low
tide, for the stations you choose (Halifax, Rimouski, Victoria, the St.
Lawrence, the Great Lakes...), from the public IWLS API, without account.
**Unofficial, not affiliated with Fisheries and Oceans Canada. Not for
navigation. Using it means accepting the
[CHS licence agreement](https://www.tides.gc.ca/en/licence-agreement). Never run by a Gladys installation in use yet** (tried against
the real API, read-only, in a local test Gladys).

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> This product is not to be used for navigation. This product was made by or for the User [the gladys-marees-canada project] and contains intellectual property (Data) of the Canadian Hydrographic Service of the Department of Fisheries and Oceans. The copyrights in the Data are and remain the property of His Majesty the King in Right of Canada and shall not be sold, licensed, leased, assigned or given to a third party. The incorporation of the Data in this product does not constitute an endorsement or an approval of this product by the Canadian Hydrographic Service, the Department of Fisheries and Oceans or His Majesty the King in Right of Canada.

## How it works

```
Gladys <-> SDK <-> src/app.js (TidesApp)   stations, what is due, devices, states, tide events, status, buttons
                    |- src/client.js        IWLS API: one request at a time, 6 s apart; the 429 pause
                    |- src/model.js         answers -> stations, points, high/low tides, values (pure)
                    |- src/triggers.js      "high or low tide in N minutes" (pure)
                    |- src/store.js         the state kept in /data (checked when read back)
                    `- src/http.js          fetch, timeout, no redirect, bounded body, host-only errors
```

- **API**: `https://api-iwls.dfo-mpo.gc.ca/api/v1` (OpenAPI description at
  `/v3/api-docs`). Published limits: 3 requests a second, 30 a minute per
  address. No ETag, no Last-Modified (`Cache-Control: no-store`).
- **Per station**: `GET /stations?code=<code>` and `/stations/<id>/metadata`
  once a week (id, name, time zone, notices); `/stations/<id>/data` with
  `wlp` (15-minute curve, 3 h back to 48 h ahead) and `wlp-hilo` (13 h
  back to 72 h ahead) every 6 hours; `wlo` (observations since the last
  one) every `poll_interval` minutes.
- **Pacing**: decided on the monotonic clock; the wall instant of each try is
  in `/data` before the request, so a restart does not read sooner (the
  first request of a process waits the gap too). 429:
  Retry-After, else 5 minutes doubling, 1 minute to 6 hours, persisted.
- **Devices**: one per station, external id `station:<code>` (5 digits),
  features `predicted-level`, `observed-level`, `observed-at`,
  `observed-minus-predicted`, `next-high-height`, `next-high-time`,
  `minutes-to-high`, `next-low-height`, `next-low-time`, `minutes-to-low`.
- **Scene trigger** `tide_coming`: filters `device`, `kind` (high, low),
  `lead` (0, 15, 30, 60, 120, 180 minutes).

No runtime dependency besides the Gladys SDK.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm audit --omit=dev
npx github:GladysAssistant/integration-store .  # store admission checks
node .github/scripts/cover.mjs                  # draws cover.png (no dependency)
```

The fixtures in `test/fixtures/` are **synthetic** answers of the same
shape as the IWLS API's (invented stations, codes, ids, notices and heights),
written by `node .github/scripts/fixtures.mjs`: the CHS licence does not allow
redistributing its Data, so no real answer is kept in this repository.
`test/kit/` is a copy of the clocks of the shared test kit.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## Credits

- Data: Canadian Hydrographic Service, Fisheries and Oceans Canada, IWLS API,
  under the [CHS licence agreement](https://www.tides.gc.ca/en/licence-agreement).
- Code written from the published OpenAPI description of the API.

## License

Code: Apache-2.0 ([LICENSE](LICENSE)). Data: CHS licence (see above).
