import { api } from './api.js';
import { store } from './appState.js';
import { runPooled } from './pool.js';
import { recordRouteIdsFromCalls } from './routes.js';

const STOP_DISCOVERY_CONCURRENCY = 8;

// Cached separately from the (frequent) calls scan below - the set of
// stops served by each line changes rarely, so re-deriving it from
// GetStopAreas on every poll tick would be wasted requests. Refreshed only
// via refreshStopsList() (see poller.js's longer STOPS_INTERVAL_MS).
let cachedStops = null;
let stopsInFlight = null;

// Finds every stop served by any line, deduped by StopArea.id (a stop can
// serve multiple lines, and GetStopAreas is queried per-line).
async function discoverAllStops(lines) {
  const results = await runPooled(lines, STOP_DISCOVERY_CONCURRENCY, (line) => api.getStopAreas(line.id, null));
  const byId = new Map();
  for (const res of results) {
    if (res.status !== 'fulfilled') continue;
    for (const stop of res.value ?? []) {
      if (!byId.has(stop.id)) byId.set(stop.id, stop);
    }
  }
  return [...byId.values()];
}

// Refreshes the cached stop list. Called rarely (poller.js) since stops
// served per line essentially never change mid-session.
export function refreshStopsList() {
  if (stopsInFlight) return stopsInFlight;
  stopsInFlight = (async () => {
    const { lines } = store.get();
    if (!lines.length) return;
    cachedStops = await discoverAllStops(lines);
  })().finally(() => {
    stopsInFlight = null;
  });
  return stopsInFlight;
}


// A journey's TransitCall.id changes at every upcoming stop along its
// route (verified live: one journey had 37 call ids, one per remaining
// stop) - so scanning every call town-wide and calling GetVehiclePosition
// on all of them (as an earlier version did) sends far more requests than
// there are actual buses (176 call ids observed for only 12 running
// journeys). Since every stop still reports the same live vehicle at its
// current position, only the call(s) with the LOWEST sequenceNumber for a
// given journeyId - i.e. its next upcoming stop - need a position fetch.
// A journey can have 2 physical vehicles (a main + "reinforcement/extra"
// bus, see ConfigOptions.textReinforcement) which show up as two distinct
// call ids at the same minimum sequenceNumber, so both are kept.
// This function also captures the next-stop name + planned/expected time
// off that same representative call, for direct display in the UI.
function buildJourneyVehicles(callsWithStop) {
  const byJourney = new Map();
  for (const { call, stopText } of callsWithStop) {
    if (call.journeyId == null) continue;
    const existing = byJourney.get(call.journeyId);
    if (!existing || call.sequenceNumber < existing.sequenceNumber) {
      byJourney.set(call.journeyId, {
        sequenceNumber: call.sequenceNumber,
        lineId: call.lineId,
        line: call.line, // short display name, e.g. "Röd." - TransitCall.line,
        // distinct from the long route-description Line.text
        destination: call.destination,
        journey: call.journey,
        stopText,
        arrival: call.arrival ?? null,
        departure: call.departure ?? null,
        callIds: [call.id],
      });
    } else if (call.sequenceNumber === existing.sequenceNumber && !existing.callIds.includes(call.id)) {
      existing.callIds.push(call.id);
    }
  }
  return byJourney;
}

let inFlight = null;

// The frequent part of discovery: scans GetCalls for every already-known
// stop (from the cached stop list - see refreshStopsList above) and
// rebuilds journeyVehicles from scratch each pass, so nextStop/planned/
// expected/occupancy data in the Live buses table - and the call ids that
// live-vehicles.js fetches positions for - stay fresh. Run on the same
// cadence as the live-vehicle position poll (see poller.js); this no
// longer re-derives the stop list itself, so it's just one GetCalls
// request per stop, pooled - much cheaper than initial stop discovery.
export function refreshCallDiscovery() {
  if (inFlight) return inFlight; // avoid overlapping scans
  inFlight = (async () => {
    if (!cachedStops) await refreshStopsList();
    const stops = cachedStops ?? [];
    if (!stops.length) return;
    const callsWithStop = [];
    await runPooled(stops, STOP_DISCOVERY_CONCURRENCY, async (stop) => {
      try {
        const resp = await api.getCalls({ fromStopAreaQuery: stop.text, lineId: 0 });
        const flat = (resp.calls ?? []).flatMap((group) => group.calls ?? []);
        recordRouteIdsFromCalls(flat);
        for (const call of flat) callsWithStop.push({ call, stopText: stop.text });
      } catch {
        // One stop failing shouldn't abort the whole town-wide scan.
      }
    });
    store.set({ journeyVehicles: buildJourneyVehicles(callsWithStop) });
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

