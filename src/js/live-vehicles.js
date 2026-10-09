import { api } from './api.js';
import { store } from './appState.js';
import { mergeLineRoutes } from './routes.js';

// Buses whose next stop is further away than this are left out: they are
// parked or between trips and not worth showing yet.
export const MAX_NEXT_STOP_MS = 10 * 60 * 1000;

export function isNextStopSoon(bus, nowMs) {
  const forecastMs = Date.parse(bus.nextStop?.forecastTime ?? '');
  if (Number.isNaN(forecastMs)) return true;
  return forecastMs - nowMs <= MAX_NEXT_STOP_MS;
}

// All journey tracking (town-wide stop scan, position fetches, next-stop
// forecasts, stale flagging) lives on the server; see server/lib/tracker.js.
// One request per tick returns every running bus ready to display.
export async function refreshLiveVehicles({ signal } = {}) {
  const data = await api.getBuses({ signal });
  const serverNowMs = Date.parse(data.serverTime ?? '');
  const nowMs = Number.isNaN(serverNowMs) ? Date.now() : serverNowMs;
  const vehicles = (data.vehicles ?? []).filter((bus) => isNextStopSoon(bus, nowMs));
  store.set({
    liveVehicles: vehicles,
    errors: { ...store.get().errors, vehicles: data.error ?? null },
  });
  mergeLineRoutes(data.lineRoutes);
  return vehicles;
}
