import { api } from './api.js';
import { store } from './appState.js';
import { runPooled } from './pool.js';
import { recordRouteIdsFromCalls } from './routes.js';
import { now } from './clock.js';

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
    resolveStopLocations(cachedStops);
  })().finally(() => {
    stopsInFlight = null;
  });
  return stopsInFlight;
}

// GetStopAreas returns stops without a `location` (verified live: all 45
// Kiruna stops come back with it unset), but FindStopArea does populate it
// for the same stop text. So coordinates are resolved once per stop and
// cached in the store for map.js to draw stop circles. Stop positions never
// move, so this runs once and is skipped for anything already resolved.
async function resolveStopLocations(stops) {
  const { stopLocations } = store.get();
  const missing = stops.filter((stop) => !stopLocations.has(stop.id));
  if (!missing.length) return;

  const results = await runPooled(missing, STOP_DISCOVERY_CONCURRENCY, (stop) => api.findStopArea(stop.text));
  let changed = false;
  results.forEach((res, i) => {
    const location = res.status === 'fulfilled' ? res.value?.location : null;
    if (location?.lat == null || location?.lon == null) return;
    stopLocations.set(missing[i].id, { text: missing[i].text, location });
    changed = true;
  });
  if (changed) store.set({ stopLocations: new Map(stopLocations) });
}


// A journey's TransitCall.id changes at every upcoming stop along its
// route (verified live: one journey had 37 call ids, one per remaining
// stop) - so scanning every call town-wide and calling GetVehiclePosition
// on all of them (as an earlier version did) sends far more requests than
// there are actual buses (176 call ids observed for only 12 running
// journeys). Since every stop still reports the same live vehicle at its
// current position, only ONE call per journey - the one for the stop the
// bus is heading to right now - needs a position fetch.
//
// That representative call is chosen by the **earliest forecast time still
// in the future**, not by the lowest sequenceNumber. In practice the API
// prunes already-passed calls, so the two agree (verified live: identical
// for all 15 running journeys). But time-based selection can't ever
// surface a stop the bus has already left, whereas lowest-sequenceNumber
// would if any stop's GetCalls response were stale or served from cache -
// exactly the "next stop never updates" failure mode. sequenceNumber is
// kept only as a tie-breaker and as a fallback when a journey has no
// future-dated call left at all (e.g. it's sitting at its terminus).
//
// A journey can have 2 physical vehicles (a main + "reinforcement/extra"
// bus, see ConfigOptions.textReinforcement) which show up as two distinct
// call ids at the same stop, so every call id sharing the chosen call's
// sequenceNumber is kept.
// This function also captures the next-stop name + planned/expected time
// off that same representative call, for direct display in the UI.
function buildJourneyVehicles(callsWithStop) {
  const currentTime = now();

  // arrival is "when the bus reaches this stop" and is the right basis for
  // a next-stop ETA; mid-route calls commonly only carry departure, so it
  // stands in when arrival is absent.
  const forecastOf = (call) => call.arrival ?? call.departure ?? null;
  const timeOf = (call) => {
    const t = forecastOf(call)?.forecastTime;
    if (!t) return null;
    const ms = new Date(t).getTime();
    return Number.isNaN(ms) ? null : ms;
  };

  const byJourney = new Map();
  for (const { call, stopText } of callsWithStop) {
    if (call.journeyId == null) continue;
    const group = byJourney.get(call.journeyId);
    if (group) group.push({ call, stopText });
    else byJourney.set(call.journeyId, [{ call, stopText }]);
  }

  const result = new Map();
  for (const [journeyId, entries] of byJourney) {
    // Prefer the soonest stop the bus hasn't reached yet; fall back to the
    // earliest remaining stop by route order when every call is in the past
    // or has no usable forecast.
    const future = entries.filter((e) => {
      const t = timeOf(e.call);
      return t != null && t > currentTime;
    });
    const pool = future.length ? future : entries;
    const chosen = pool.reduce((best, e) => {
      if (!best) return e;
      const a = timeOf(e.call);
      const b = timeOf(best.call);
      if (a != null && b != null && a !== b) return a < b ? e : best;
      if (a != null && b == null) return e;
      if (a == null && b != null) return best;
      return e.call.sequenceNumber < best.call.sequenceNumber ? e : best;
    }, null);
    if (!chosen) continue;

    const { call, stopText } = chosen;
    // Both vehicles of a reinforced journey call at the same stop, so match
    // on sequenceNumber rather than on the chosen call id alone.
    const callIds = [...new Set(entries.filter((e) => e.call.sequenceNumber === call.sequenceNumber).map((e) => e.call.id))];

    result.set(journeyId, {
      sequenceNumber: call.sequenceNumber,
      lineId: call.lineId,
      line: call.line, // short display name, e.g. "Röd." - TransitCall.line,
      // distinct from the long route-description Line.text
      destination: call.destination,
      journey: call.journey,
      stopText,
      arrival: call.arrival ?? null,
      departure: call.departure ?? null,
      callIds,
    });
  }
  return result;
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

