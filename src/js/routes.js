import { api } from './api.js';
import { store } from './appState.js';
import { LKAB_BOUND_ROUTE_ID, LKAB_RETURN_ROUTE_ID, correctLkabBoundRoute } from './routeCorrections.js';

// NOTE: TransitCall exposes lineId but not directionId, so discovered route
// variants are tracked per-line only (not per-direction), even though the
// discovery probe below iterates directions to maximize stop coverage and
// find more route variants for a line.

// Records every routeId seen on flattened TransitCalls (from any GetCalls
// response, whether from selected-stop polling or discovery probing), and
// kicks off geometry fetches for any routeId not already cached. Journey/
// vehicle bookkeeping (journeyVehicles) is handled separately in
// call-discovery.js, since it needs a full town-wide batch to pick the
// right representative call per journey (see there for why).
const geometryRequests = new Map();
export function recordRouteIdsFromCalls(transitCalls) {
  const { lineRoutes, routeGeometry } = store.get();
  let routesChanged = false;
  const toFetch = [];

  for (const call of transitCalls) {
    if (!call.routeId) continue;
    const set = lineRoutes.get(call.lineId) ?? new Set();
    if (!set.has(call.routeId)) {
      set.add(call.routeId);
      lineRoutes.set(call.lineId, set);
      routesChanged = true;
    }
    if (!routeGeometry.has(call.routeId) && !geometryRequests.has(call.routeId) && !toFetch.includes(call.routeId)) {
      toFetch.push(call.routeId);
    }
  }

  if (toFetch.length) fetchGeometries(toFetch);
  if (routesChanged) {
    store.set({ lineRoutes: new Map(lineRoutes) });
  }
}

async function fetchGeometries(routeIds) {
  const ids = [...routeIds];
  if (ids.includes(LKAB_BOUND_ROUTE_ID) &&
      !store.get().routeGeometry.has(LKAB_RETURN_ROUTE_ID) && !ids.includes(LKAB_RETURN_ROUTE_ID)) {
    ids.push(LKAB_RETURN_ROUTE_ID);
  }
  const requests = ids.map((id) => {
    let request = geometryRequests.get(id);
    if (!request) {
      request = api.getMapRoute(id);
      geometryRequests.set(id, request);
    }
    return request;
  });
  try {
    const results = await Promise.allSettled(requests);
    const state = store.get();
    const next = new Map(state.routeGeometry);
    let changed = false;
    results.forEach((res, i) => {
      if (res.status === 'fulfilled' && res.value && !next.has(ids[i])) {
        next.set(ids[i], res.value);
        changed = true;
      }
    });
    let routesError = null;
    if (ids.includes(LKAB_BOUND_ROUTE_ID)) {
      const outbound = next.get(LKAB_BOUND_ROUTE_ID);
      if (outbound) {
        try {
          const corrected = correctLkabBoundRoute(outbound, next.get(LKAB_RETURN_ROUTE_ID));
          if (corrected !== outbound) {
            next.set(LKAB_BOUND_ROUTE_ID, corrected);
            changed = true;
          }
        } catch (error) {
          next.delete(LKAB_BOUND_ROUTE_ID);
          changed = true;
          routesError = error.message;
        }
      } else {
        routesError = 'Unable to load the LKAB-bound route geometry.';
      }
    }
    const errorChanged = ids.includes(LKAB_BOUND_ROUTE_ID) && state.errors.routes !== routesError;
    if (changed || errorChanged) {
      store.set({
        ...(changed ? { routeGeometry: next } : {}),
        ...(errorChanged ? { errors: { ...state.errors, routes: routesError } } : {}),
      });
    }
  } finally {
    ids.forEach((id, i) => {
      if (geometryRequests.get(id) === requests[i]) geometryRequests.delete(id);
    });
  }
}

const probeInFlight = new Set();
const probeFailedAt = new Map(); // lineId -> Date.now() of last unsuccessful probe
const PROBE_RETRY_MS = 60_000;

// Called when a user enables a line filter whose geometry is still unknown.
// A line can legitimately have no live calls right now (overnight, gaps
// between trips, disruption) - that's not an error, just "not yet known".
// We back off and let a later probe (or incidental discovery from normal
// calls polling) try again instead of treating it as a failure.
export async function ensureLineRouteDiscovered(lineId) {
  const { lineRoutes } = store.get();
  if ((lineRoutes.get(lineId)?.size ?? 0) > 0) return;
  if (probeInFlight.has(lineId)) return;
  const lastFail = probeFailedAt.get(lineId);
  if (lastFail && Date.now() - lastFail < PROBE_RETRY_MS) return;

  probeInFlight.add(lineId);
  let found = false;
  try {
    let directions = [];
    try {
      directions = await api.getDirections(lineId);
    } catch {
      // Fall back to a single "no direction" probe below.
    }
    const directionIds = directions.length ? directions.map((d) => d.id) : [null];

    for (const directionId of directionIds) {
      try {
        const stops = await api.getStopAreas(lineId, directionId);
        for (const stop of stops.slice(0, 3)) {
          try {
            const resp = await api.getCalls({ fromStopAreaQuery: stop.text, lineId });
            const flat = (resp.calls ?? []).flatMap((group) => group.calls ?? []);
            if (flat.length) {
              recordRouteIdsFromCalls(flat);
              found = true;
              break;
            }
          } catch {
            // Try the next sample stop.
          }
        }
      } catch {
        // Try the next direction.
      }
    }
  } finally {
    probeInFlight.delete(lineId);
    if (!found) probeFailedAt.set(lineId, Date.now());
  }
}
