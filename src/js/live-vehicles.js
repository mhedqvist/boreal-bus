import { api } from './api.js';
import { store } from './appState.js';
import { runPooled } from './pool.js';
import { now } from './clock.js';

const VEHICLE_FETCH_CONCURRENCY = 15;

// The API has no "in service" / active flag anywhere in VehiclePosition or
// TransitCall (see openapi.yaml) - the only freshness signal available is
// how old VehiclePosition.timestamp is. A call whose vehicle GPS hasn't
// reported in a while (trip finished, vehicle offline, journey is
// scheduled-only with no real vehicle assigned yet) still gets echoed back
// by GetVehiclePosition with its last known fix, which is why some markers
// otherwise look "live" but never move. Anything older than this is flagged
// stale (shown, not hidden - see initial_plan.md error-handling philosophy)
// rather than silently dropped, since an occasional slow GPS update is
// normal and shouldn't make a real in-service bus disappear.
export const STALE_THRESHOLD_MS = 3 * 60 * 1000;

// VehiclePosition.id merely echoes back the requested callId (verified live
// - it is not a stable per-vehicle identifier), so the same physical bus
// commonly shows up under several call ids (one per upcoming stop on its
// journey). Positions are deduped onto one physical vehicle by rounding
// (lat, lon, timestamp) into a key: two call ids reporting the same
// location at the same instant are treated as the same bus.
function positionKey(position) {
  return `${position.location.lat.toFixed(5)}|${position.location.lon.toFixed(5)}|${position.timestamp}`;
}

// Fetches GetVehiclePosition only for each journey's representative call
// id(s) (journeyVehicles, built by call-discovery.js's town-wide scan -
// the call id with the lowest/next-upcoming sequenceNumber per journey),
// then dedupes onto distinct physical vehicles so every live bus can be
// plotted on its route simultaneously. This is a small, bus-sized request
// set (roughly one or two calls per running journey) rather than every
// call id town-wide, which would be ~15x larger since a journey's call id
// changes at every remaining stop along its route (see initial_plan.md).
export async function fetchAllLiveVehicles({ signal } = {}) {
  const { journeyVehicles } = store.get();
  const entries = [];
  for (const [journeyId, info] of journeyVehicles.entries()) {
    for (const callId of info.callIds) entries.push({ callId, journeyId, info });
  }
  if (!entries.length) {
    store.set({ liveVehicles: [] });
    return [];
  }

  const results = await runPooled(entries, VEHICLE_FETCH_CONCURRENCY, (entry) =>
    api.getVehiclePosition(entry.callId, { signal })
  );

  const byKey = new Map();
  results.forEach((res, i) => {
    if (res.status !== 'fulfilled' || !res.value?.location) return;
    const { callId, journeyId, info } = entries[i];
    const key = positionKey(res.value);
    const ageMs = now() - new Date(res.value.timestamp).getTime();
    const stale = !Number.isNaN(ageMs) && ageMs > STALE_THRESHOLD_MS;
    const existing = byKey.get(key);
    if (existing) {
      existing.callIds.push(callId);
    } else {
      // Prefer the arrival forecast for "next stop" info (when the bus is
      // expected to reach that upcoming stop); fall back to departure for
      // a call representing the very start of a journey, which may only
      // have a departure forecast.
      const forecast = info.arrival ?? info.departure ?? null;
      byKey.set(key, {
        key,
        position: res.value,
        lineId: info.lineId,
        line: info.line,
        destination: info.destination,
        journeyId,
        callIds: [callId],
        ageMs,
        stale,
        nextStop: {
          stopText: info.stopText,
          plannedTime: forecast?.plannedTime ?? null,
          forecastTime: forecast?.forecastTime ?? null,
          occupancyPercent: forecast?.occupancyPercent ?? null,
        },
      });
    }
  });

  const liveVehicles = [...byKey.values()];
  store.set({ liveVehicles });
  return liveVehicles;
}
