// -----------------------------------------------------------------------------
// The user-facing texts: the connection status and the action answers, in
// English and French. Instants are shown in the time zone of the first
// station (UTC before it is known), with its abbreviation.
// -----------------------------------------------------------------------------

import { localTime } from './model.js';

/** Why a read failed, by IwlsError kind. */
export function reason(kind) {
  switch (kind) {
    case 'limited':
      return { en: 'too many requests, paused', fr: 'trop de requêtes, en pause' };
    case 'server':
      return { en: 'service unavailable', fr: 'service indisponible' };
    case 'not_found':
    case 'refused':
      return { en: 'refused by the service', fr: 'refusé par le service' };
    case 'answer':
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case 'http':
      return { en: 'refused by the service', fr: 'refusé par le service' };
    default:
      return { en: 'network error', fr: 'erreur réseau' };
  }
}

export const NOT_FOR_NAVIGATION = {
  en: 'Predictions of the Canadian Hydrographic Service, not for navigation.',
  fr: 'Prédictions du Service hydrographique du Canada, pas pour la navigation.',
};

export const T = {
  noStation: {
    en: 'No station chosen: enter station codes (5 digits, e.g. 00490 for Halifax) in the configuration. The "Search stations" button finds them.',
    fr: 'Aucune station choisie : saisissez des codes de stations (5 chiffres, par ex. 00490 pour Halifax) dans la configuration. Le bouton « Chercher des stations » les trouve.',
  },
  paused: (until, tz) => ({
    en: `The IWLS API asked to slow down: paused until ${localTime(until, tz)}.`,
    fr: `L'API IWLS a demandé de ralentir : en pause jusqu'à ${localTime(until, tz)}.`,
  }),
  ok: ({ stations, predicted, observed, withObserved, interval }) => ({
    en: `${stations} station(s): current predictions for ${predicted}, a recent observation for ${observed} of the ${withObserved} that measure (read every ${interval} min).`,
    fr: `${stations} station(s) : prédictions à jour pour ${predicted}, observation récente pour ${observed} des ${withObserved} qui mesurent (lues toutes les ${interval} min).`,
  }),
  failed: (r) => ({
    en: `Last read failed (${r.en}); the values already known are kept while they are current.`,
    fr: `La dernière lecture a échoué (${r.fr}) ; les valeurs déjà connues sont gardées tant qu'elles sont actuelles.`,
  }),
  unknown: (codes) => ({
    en: `Unknown station code(s): ${codes.join(', ')}.`,
    fr: `Code(s) de station inconnu(s) : ${codes.join(', ')}.`,
  }),
  invalid: (entries) => ({
    en: `Not a station code (5 digits), ignored: ${entries.join(', ')}.`,
    fr: `Pas un code de station (5 chiffres), ignoré : ${entries.join(', ')}.`,
  }),
  tooMany: (max) => ({
    en: `Only the first ${max} stations are read.`,
    fr: `Seules les ${max} premières stations sont lues.`,
  }),
  silent: (names) => ({
    en: `No observation for 2 hours or more (station silent, delayed or under maintenance): ${names.join(', ')}; the observed level is not published.`,
    fr: `Aucune observation depuis 2 heures ou plus (station muette, en retard ou en maintenance) : ${names.join(', ')} ; le niveau observé n'est pas publié.`,
  }),
  questionable: (names) => ({
    en: `Last observation flagged questionable by the service, not published: ${names.join(', ')}.`,
    fr: `Dernière observation jugée douteuse par le service, non publiée : ${names.join(', ')}.`,
  }),
  noPrediction: (names) => ({
    en: `No current prediction: ${names.join(', ')}.`,
    fr: `Aucune prédiction actuelle : ${names.join(', ')}.`,
  }),
  noCurve: (names) => ({
    en: `No prediction curve every 15 minutes from the service (the predicted level is not updated; the high and low tides go on if the station has them): ${names.join(', ')}.`,
    fr: `Pas de courbe de prédiction aux 15 minutes du service (le niveau prédit n'est pas mis à jour ; les pleines et basses mers continuent si la station en a) : ${names.join(', ')}.`,
  }),
  unclassified: (names) => ({
    en: `Some predicted tides could not be told high or low and are left out (no event for them): ${names.join(', ')}.`,
    fr: `Certaines marées prédites n'ont pu être dites pleines ou basses et sont écartées (aucun événement pour elles) : ${names.join(', ')}.`,
  }),
  notRead: (names) => ({
    en: `Not read yet: ${names.join(', ')}.`,
    fr: `Pas encore lue(s) : ${names.join(', ')}.`,
  }),
  clockSkew: (minutes) => ({
    en: `The clock of the container differs from the one of the service by ${minutes} min: the countdowns and the tide events follow the container clock.`,
    fr: `L'horloge du conteneur diffère de celle du service de ${minutes} min : les comptes à rebours et les événements de marée suivent l'horloge du conteneur.`,
  }),
  storeUnreadable: {
    en: 'The state file in /data cannot be read: it is left untouched, and nothing is saved until it can be read.',
    fr: "Le fichier d'état dans /data est illisible : il est laissé tel quel, et rien n'est enregistré tant qu'il ne peut pas être lu.",
  },
  storeSetAside: {
    en: 'The state file in /data was corrupt: set aside as marees-canada-state.json.bad, the integration started afresh.',
    fr: "Le fichier d'état dans /data était corrompu : mis de côté sous marees-canada-state.json.bad, l'intégration est repartie de zéro.",
  },
  configFailed: (at, tz) => ({
    en: `The configuration could not be read from Gladys: new try at ${localTime(at, tz)}.`,
    fr: `La configuration n'a pas pu être lue depuis Gladys : nouvel essai à ${localTime(at, tz)}.`,
  }),
};
