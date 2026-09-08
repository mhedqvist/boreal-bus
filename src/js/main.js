import { loadConfig } from './config.js';
import { loadLines } from './lines.js';
import { initMap } from './map.js';
import { initPoller } from './poller.js';
import { initUi } from './ui.js';
import { initClockOffset } from './clock.js';

async function main() {
  try {
    await loadConfig();
  } catch (err) {
    showFatalError(`Failed to load configuration: ${err.message}. Reload the page to try again.`);
    return;
  }

  // Lines and clock offset can load independently of each other.
  await Promise.allSettled([loadLines(), initClockOffset()]);

  initMap('map');
  initUi();
  // initPoller kicks off the town-wide call-discovery scan (call-discovery.js)
  // and the per-callId live-vehicle scan (live-vehicles.js), which together
  // populate routes/markers/the live buses table without any user
  // interaction (see docs/initial_plan.md).
  initPoller();
}

function showFatalError(message) {
  const el = document.getElementById('app-error');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

main();
