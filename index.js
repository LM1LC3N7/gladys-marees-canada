// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect(),
// and delegates to the TidesApp (src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { TidesApp } from './src/app.js';
import { ACTIONS } from './src/constants.js';
import { fileStorage } from './src/store.js';

const gladys = new GladysIntegration();
// The 429 pause, the instant of every try, the stations, their predictions
// and last observation, and the tides already announced are kept in /data,
// the one writable volume: a restart loop never reads faster nor announces a
// tide twice.
const app = new TidesApp({ gladys, storage: fileStorage('/data/marees-canada-state.json') });

// --- Discovery: the stations already read (no extra call) --------------------
gladys.onScanRequest(() => app.publishDiscovered({ force: true }));

// --- A device was created: its values now, not at the next minute -----------
gladys.onDeviceCreated(() => app.deviceCreated());

// --- Configuration screen buttons ----------------------------------------------
gladys.onAction(ACTIONS.TEST, () => app.testConnection());
gladys.onAction(ACTIONS.SEARCH, (fields) => app.search(fields));

// --- Configuration changed by the user -----------------------------------------
gladys.onConfigUpdated(async (config) => {
  logger.info('Configuration updated: restarting');
  await app.start(config);
});

// --- Connection lifecycle -------------------------------------------------------
// A reconnection keeps the pause, the tries and the tides announced; it
// publishes the status and the Discovery tab again (Gladys keeps them in
// memory only). A configuration Gladys does not give is asked again by a
// timer (1 minute, then more and more spaced, without end), with an error
// status.
gladys.on('connected', async () => {
  try {
    await app.connect(() => gladys.getConfig());
  } catch (err) {
    logger.error('Start failed', err);
  }
});
gladys.on('disconnected', () => app.stop());
gladys.handleShutdown(() => app.shutdown());

logger.info('Starting the Canadian tides integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
