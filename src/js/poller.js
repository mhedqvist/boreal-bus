import { store } from './appState.js';
import { fetchCallsForSelectedStop } from './calls.js';
import { refreshLiveVehicles } from './live-vehicles.js';
import { refreshStopLocations } from './stop-locations.js';

const LIVE_VEHICLES_INTERVAL_MS = 60000; // one /api/buses request per tick
const CALLS_INTERVAL_MS = 60000; // selected-stop GetCalls poll

let liveVehiclesTimer = null;
let callsTimer = null;
let callsAbort = null;
let liveVehiclesAbort = null;
let liveVehiclesRunning = false;
let nextLiveVehiclesAt = null;

// Read by countdown.js; deliberately not in the store so the once-a-second
// countdown doesn't re-render the map and tables.
export function getLiveVehiclesSchedule() {
  return { nextAt: liveVehiclesTimer ? nextLiveVehiclesAt : null, running: liveVehiclesRunning };
}

// Generation token: bumped on stop select/deselect and pause/resume so
// in-flight responses tied to a stale state never get applied.
let generation = 0;
let paused = false;

// The server does the scanning and caching, so a tick is a single request.
// A tick is skipped rather than stacked if the previous one is still running
// (the very first request can be slow while the server warms up).
async function pollLiveVehicles() {
  nextLiveVehiclesAt = Date.now() + LIVE_VEHICLES_INTERVAL_MS;
  if (liveVehiclesRunning) return;
  liveVehiclesRunning = true;
  const myGeneration = generation;
  liveVehiclesAbort?.abort();
  liveVehiclesAbort = new AbortController();
  const { signal } = liveVehiclesAbort;
  try {
    await refreshLiveVehicles({ signal });
    if (myGeneration !== generation) return; // stale
    await refreshStopLocations({ signal }).catch(() => {}); // retried next tick
  } catch (err) {
    if (err.name !== 'AbortError' && myGeneration === generation) {
      store.set({ errors: { ...store.get().errors, vehicles: 'Unable to refresh live bus data.' } });
    }
  } finally {
    liveVehiclesRunning = false;
  }
}

async function pollCalls() {
  const { selectedStop } = store.get();
  if (!selectedStop) return;
  const myGeneration = generation;
  callsAbort?.abort();
  callsAbort = new AbortController();
  try {
    await fetchCallsForSelectedStop({ signal: callsAbort.signal });
    if (myGeneration !== generation) return; // selection changed mid-flight
  } catch (err) {
    if (err.name === 'AbortError' || myGeneration !== generation) return;
    store.set({ errors: { ...store.get().errors, calls: err.message } });
  }
}

function startLiveVehiclesPolling() {
  stopLiveVehiclesPolling();
  pollLiveVehicles();
  liveVehiclesTimer = setInterval(pollLiveVehicles, LIVE_VEHICLES_INTERVAL_MS);
}

function stopLiveVehiclesPolling() {
  if (liveVehiclesTimer) clearInterval(liveVehiclesTimer);
  liveVehiclesTimer = null;
  liveVehiclesAbort?.abort();
}

function startCallsPolling() {
  stopCallsPolling();
  pollCalls();
  callsTimer = setInterval(pollCalls, CALLS_INTERVAL_MS);
}

function stopCallsPolling() {
  if (callsTimer) clearInterval(callsTimer);
  callsTimer = null;
  callsAbort?.abort();
}

export function initPoller() {
  startLiveVehiclesPolling();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    else resume();
  });
}

// Called by stops.js whenever a stop is selected (search result, map click,
// or a new selection replacing a previous one).
export function onStopSelected() {
  generation += 1;
  startCallsPolling();
}

export function onStopDeselected() {
  generation += 1;
  stopCallsPolling();
  store.set({ calls: [], isStopCancelled: false, messages: [] });
}

function pause() {
  paused = true;
  stopLiveVehiclesPolling();
  stopCallsPolling();
}

function resume() {
  if (!paused) return;
  paused = false;
  generation += 1; // discard anything that was in flight before pausing
  startLiveVehiclesPolling();
  if (store.get().selectedStop) startCallsPolling();
}
