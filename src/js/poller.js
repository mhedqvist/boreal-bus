import { store } from './appState.js';
import { api } from './api.js';
import { fetchCallsForSelectedStop } from './calls.js';
import { refreshCallDiscovery, refreshStopsList } from './call-discovery.js';
import { fetchAllLiveVehicles } from './live-vehicles.js';

const VEHICLE_INTERVAL_MS = 15000; // town-wide GetVehiclePositions poll
const LIVE_VEHICLES_INTERVAL_MS = 15000; // call-discovery scan + per-callId GetVehiclePosition scan
const CALLS_INTERVAL_MS = 15000; // selected-stop GetCalls poll
const STOPS_INTERVAL_MS = 5 * 60 * 1000; // stop-list refresh (rarely changes)

let vehicleTimer = null;
let liveVehiclesTimer = null;
let callsTimer = null;
let stopsTimer = null;
let vehicleAbort = null;
let callsAbort = null;
let liveVehiclesAbort = null;
let liveVehiclesRunning = false;

// Generation token: bumped on stop select/deselect and pause/resume so
// in-flight responses tied to a stale state never get applied.
let generation = 0;
let paused = false;

async function pollVehicles() {
  const myGeneration = generation;
  vehicleAbort?.abort();
  vehicleAbort = new AbortController();
  try {
    const vehicles = await api.getVehiclePositions({ signal: vehicleAbort.signal });
    if (myGeneration !== generation) return; // stale
    store.set({ vehicles, errors: { ...store.get().errors, vehicles: null } });
  } catch (err) {
    if (err.name === 'AbortError' || myGeneration !== generation) return;
    store.set({ errors: { ...store.get().errors, vehicles: err.message } });
  }
}

// Scans GetCalls for every known stop to rebuild journeyVehicles (fresh
// nextStop/planned/expected data + representative call ids -
// see call-discovery.js), then immediately fetches GetVehiclePosition for
// those call ids so position and "next stop" info advance together on
// every tick. A tick is skipped rather than stacked if the previous one is
// still running (both parts combined can take a few seconds).
async function pollLiveVehicles() {
  if (liveVehiclesRunning) return;
  liveVehiclesRunning = true;
  const myGeneration = generation;
  liveVehiclesAbort?.abort();
  liveVehiclesAbort = new AbortController();
  try {
    await refreshCallDiscovery();
    if (myGeneration !== generation) return; // stale
    await fetchAllLiveVehicles({ signal: liveVehiclesAbort.signal });
    if (myGeneration !== generation) return; // stale
  } catch (err) {
    if (err.name !== 'AbortError' && myGeneration === generation) {
      store.set({ errors: { ...store.get().errors, vehicles: err.message } });
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

function startVehiclePolling() {
  stopVehiclePolling();
  pollVehicles();
  vehicleTimer = setInterval(pollVehicles, VEHICLE_INTERVAL_MS);
}

function stopVehiclePolling() {
  if (vehicleTimer) clearInterval(vehicleTimer);
  vehicleTimer = null;
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

function startDiscoveryPolling() {
  stopDiscoveryPolling();
  refreshStopsList();
  stopsTimer = setInterval(refreshStopsList, STOPS_INTERVAL_MS);
}

function stopDiscoveryPolling() {
  if (stopsTimer) clearInterval(stopsTimer);
  stopsTimer = null;
}

export function initPoller() {
  startVehiclePolling();
  startDiscoveryPolling();
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
  stopVehiclePolling();
  stopLiveVehiclesPolling();
  stopCallsPolling();
  stopDiscoveryPolling();
}

function resume() {
  if (!paused) return;
  paused = false;
  generation += 1; // discard anything that was in flight before pausing
  startVehiclePolling();
  startDiscoveryPolling();
  startLiveVehiclesPolling();
  if (store.get().selectedStop) startCallsPolling();
}
