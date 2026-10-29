// -----------------------------------------------------------------------------
// Writes the fixtures of the tests: SYNTHETIC answers of the IWLS API, of the
// same shape as the real ones (the keys, the formats, a 15-minute curve, high
// and low tides, observations every minute), with invented stations, codes,
// ids, names, notices and heights. No answer of the real service is kept in
// this repository: the CHS licence does not allow redistributing its Data.
//
//   node .github/scripts/fixtures.mjs
//
// Heights: mean + amp·cos(2π(t − high)/T) + diurnal·cos(2π(t − high)/2T), T the
// M2 period (12.42 h): a semidiurnal tide with an unequal pair, its high tide
// at `high`. The high and low tides are the extrema of that curve, minute by
// minute, as the API gives them (time and height, no "high" or "low").
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';

const MIN = 60_000;
const H = 60 * MIN;
const T = 12.4206 * H;
const at = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const r3 = (v) => Math.round(v * 1000) / 1000;

export const HAVRE = {
  code: '90490',
  id: 'a0a0a0a0a0a0a0a0a0a09049',
  name: 'Havre-Fictif',
  province: 'NS',
  tz: 'Canada/Atlantic',
  high: Date.parse('2026-10-30T02:25:00Z'),
  mean: 0.9,
  amp: 0.7,
  diurnal: 0.08,
};
export const BAIE = {
  code: '97120',
  id: 'b0b0b0b0b0b0b0b0b0b09712',
  name: 'Baie-Imaginaire',
  province: 'BC',
  tz: 'Canada/Pacific',
  high: Date.parse('2026-10-29T22:22:00Z'),
  mean: 1.6,
  amp: 1.1,
  diurnal: 0.25,
};

const height = (s, t) =>
  s.mean +
  s.amp * Math.cos((2 * Math.PI * (t - s.high)) / T) +
  s.diurnal * Math.cos((2 * Math.PI * (t - s.high)) / (2 * T));

const point = (t, v, qc = '2', series = 'c0c0c0c0c0c0c0c0c0c0c0c0') => ({
  eventDate: at(t),
  qcFlagCode: qc,
  reviewed: false,
  timeSeriesId: series,
  value: r3(v),
});

function curve(s, from, to) {
  const out = [];
  for (let t = from; t <= to; t += 15 * MIN) {
    out.push(point(t, height(s, t)));
  }
  return out;
}

function extremes(s, from, to) {
  const out = [];
  for (let t = from; t <= to; t += MIN) {
    const [a, b, c] = [height(s, t - MIN), height(s, t), height(s, t + MIN)];
    if ((b > a && b >= c) || (b < a && b <= c)) {
      out.push(point(t, b, '1'));
    }
  }
  return out;
}

function observations(s, from, to) {
  const out = [];
  for (let t = from, k = 0; t <= to; t += MIN, k += 1) {
    out.push(point(t, height(s, t) + 0.2 + 0.01 * Math.sin(k), '1'));
  }
  return out;
}

const series = (codes) =>
  codes.map((code, i) => ({
    code,
    id: `d0d0d0d0d0d0d0d0d0d0d0d${i}`,
    nameEn: {
      wlo: 'Water level official value',
      wlp: 'Water level predictions',
      'wlp-hilo': 'High and Low Tide Predictions',
    }[code],
    nameFr: {
      wlo: "Niveau d'eau, valeur officielle",
      wlp: "Prédictions de niveaux d'eau",
      'wlp-hilo': 'Prédictions de pleines et basses mers',
    }[code],
    owner: 'CHS-SHC',
    phenomenonId: 'e0e0e0e0e0e0e0e0e0e0e0e0',
  }));

const station = (
  s,
  { codes = ['wlo', 'wlp', 'wlp-hilo'], operating = true, alternative } = {},
) => ({
  ...(alternative ? { alternativeName: alternative } : {}),
  chsRegionCode: { NS: 'ATL', BC: 'PAC', QC: 'QUE', PE: 'ATL', ON: 'CNA' }[s.province],
  code: s.code,
  id: s.id,
  latitude: 45,
  longitude: -64,
  officialName: s.name,
  operating,
  provinceCode: s.province,
  timeSeries: series(codes),
  type: 'PERMANENT',
});

const NOTICE_EN =
  'Invented notice of a fictional port authority, for the tests only: the air draft figures of this fictional bridge are supplementary and do not replace the procedures of the fictional harbour master, who may ask for more checks at any time before a vessel passes under the bridge, and may delay or restrict the passage of any vessel.';
const NOTICE_FR =
  "Avis inventé d'une autorité portuaire fictive, pour les tests seulement : les tirants d'air de ce pont fictif sont complémentaires et ne remplacent pas les procédures de la capitainerie fictive, qui peut demander d'autres vérifications à tout moment avant le passage d'un navire sous le pont, et retarder ou restreindre ce passage.";

const metadata = (s, { notice = false } = {}) => ({
  chsRegionCode: station(s).chsRegionCode,
  classCode: 'B',
  code: s.code,
  datums: [{ code: 'CGVD2013', offset: -1.0, offsetPrecision: 2 }],
  id: s.id,
  isTidal: true,
  officialName: s.name,
  operating: true,
  owner: 'CHS-SHC',
  provinceCode: s.province,
  publicNotificationEn: notice ? NOTICE_EN : '',
  publicNotificationFr: notice ? NOTICE_FR : '',
  status: 'OK',
  timeZoneCode: s.tz,
  type: 'PERMANENT',
  waterBody: 'BAY',
});

const write = (name, body) =>
  writeFileSync(
    new URL(`../../test/fixtures/${name}`, import.meta.url),
    `${JSON.stringify(body, null, 1)}\n`,
  );

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const curveFrom = Date.parse('2026-10-29T18:00:00Z');
  const curveTo = Date.parse('2026-10-31T21:00:00Z');
  const hiloFrom = Date.parse('2026-10-29T08:00:00Z');
  const hiloTo = Date.parse('2026-11-02T00:00:00Z');
  write('havre-station.json', [station(HAVRE)]);
  write('havre-metadata.json', metadata(HAVRE, { notice: true }));
  write('havre-wlp.json', curve(HAVRE, curveFrom, curveTo));
  write('havre-hilo.json', extremes(HAVRE, hiloFrom, hiloTo));
  write('baie-station.json', [station(BAIE)]);
  write('baie-metadata.json', metadata(BAIE));
  write('baie-wlp.json', curve(BAIE, curveFrom, curveTo));
  write('baie-hilo.json', extremes(BAIE, hiloFrom, hiloTo));
  write(
    'baie-wlo.json',
    observations(BAIE, Date.parse('2026-10-29T20:00:00Z'), Date.parse('2026-10-29T21:16:00Z')),
  );
  const other = (code, name, province, id) => ({ code, name, province, id });
  write('stations-subset.json', [
    station(other('94315', 'Bassin-Factice', 'QC', 'f0f0f0f0f0f0f0f0f0f09431'), {
      codes: ['wlo', 'wlp', 'wlp-hilo'],
      operating: false,
      alternative: 'Leaf Pond, ÉTANG DES FEUILLES, Étang des Feuilles',
    }),
    station(other('93057', 'Saint-Joseph-de-la-Fiction', 'QC', 'f0f0f0f0f0f0f0f0f0f09305')),
    station(HAVRE),
    station(BAIE),
    station(other('92985', 'Pointe-aux-Exemples', 'QC', 'f0f0f0f0f0f0f0f0f0f09298')),
    station(other('98860', 'Île-Inventée', 'BC', 'f0f0f0f0f0f0f0f0f0f09886'), {
      codes: ['wlp', 'wlp-hilo'],
      operating: false,
    }),
    station(other('91700', 'Port-Témoin', 'PE', 'f0f0f0f0f0f0f0f0f0f09170')),
    station(other('21500', 'Lac-Factice', 'ON', 'f0f0f0f0f0f0f0f0f0f02150'), { codes: ['wlo'] }),
  ]);
  write('error-400.json', {
    timestamp: '2026-10-29T21:07:07.842012831Z',
    status: '400 BAD_REQUEST',
    message: 'Constraints not respected',
    path: `/api/v1/stations/${BAIE.id}/data`,
    errors: [
      '2026-10-01T18:00:00Z / 2026-10-30T12:00:00Z: date interval should not be bigger than 7 days',
    ],
  });
  console.log('fixtures written');
}
