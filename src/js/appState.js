import { createStore } from './state.js';

// Single shared application state. See initial_plan.md for the rationale
// behind each field (esp. lineRoutes/routeGeometry and the
// journeyVehicles/liveVehicles design).
export const store = createStore({
  lines: [], // Line[] from GetLines
  activeLineIds: new Set(), // line filter: ids currently shown

  selectedStop: null, // StopArea | null
  calls: [], // flattened TransitCall[] for the selected stop
  isStopCancelled: false,
  messages: [], // TrafficMessage[] for the selected stop

  vehicles: [], // VehiclePosition[] from the town-wide GetVehiclePositions
  // endpoint. Observed to return [] live even when buses are running (see
  // initial_plan.md) - kept only as a secondary/fallback source; liveVehicles
  // below is the primary display source.
  liveVehicles: [], // [{ key, position, lineId, line, destination, journeyId,
  // callIds, ageMs, stale, nextStop: { stopText, plannedTime, forecastTime,
  // occupancyPercent } }], one entry per distinct physical bus, built by
  // calling GetVehiclePosition for the representative call id(s) of every
  // journey in journeyVehicles and deduping same-instant/same-location
  // results (see live-vehicles.js - VehiclePosition.id merely echoes the
  // requested callId, so it can't be used as a vehicle identity by itself).
  // `line` is the short display name (TransitCall.line, e.g. "Röd."), used
  // for compact table/tooltip display instead of the long Line.text.

  selectedVehicleJourneyId: null, // journeyId of the bus highlighted via a
  // Live buses table row click (see vehicleSelection.js). Tracked by
  // journeyId, not liveVehicles[].key, because key is derived from
  // (lat, lon, timestamp) and changes every poll tick as a bus moves -
  // journeyId is the only identity that's stable across polls.

  lineRoutes: new Map(), // lineId -> Set<routeId>, discovered lazily
  routeGeometry: new Map(), // routeId -> MapRoute
  journeyVehicles: new Map(), // journeyId -> { sequenceNumber, lineId, line,
  // destination, journey, stopText, arrival, departure, callIds: string[] },
  // one entry per currently running journey/bus, rebuilt from scratch on
  // every call-discovery.js scan. callIds holds the call id(s) at that
  // journey's lowest (next-upcoming) sequenceNumber - usually 1, but 2 when
  // a journey has a main + reinforcement/extra vehicle both reporting at
  // the same stop. live-vehicles.js fetches GetVehiclePosition only for
  // these call ids (a small, bus-sized set) instead of every call id
  // town-wide (which would be ~15x larger - see initial_plan.md). `line` is
  // TransitCall.line (short display name, e.g. "Röd.").

  clockOffsetMs: 0, // serverTime - clientTime, from GetSystemTimestamp

  errors: {
    config: null,
    lines: null,
    vehicles: null,
    calls: null,
    stopNotFound: null,
  },
});
