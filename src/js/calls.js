import { api } from './api.js';
import { store } from './appState.js';
import { recordRouteIdsFromCalls } from './routes.js';

// Fetches GetCalls for the currently selected stop. Empty results are a
// valid "no departures" state, not an error; isStopCancelled/messages are
// surfaced as-is for the UI layer to render.
export async function fetchCallsForSelectedStop({ signal } = {}) {
  const { selectedStop } = store.get();
  if (!selectedStop) return [];

  const resp = await api.getCalls({ fromStopAreaQuery: selectedStop.text }, { signal });
  const flat = (resp.calls ?? []).flatMap((group) => group.calls ?? []);

  // Feed any newly-seen routeIds into the lazy route-geometry cache.
  recordRouteIdsFromCalls(flat);

  store.set({
    calls: flat,
    isStopCancelled: !!resp.isStopCancelled,
    messages: resp.messages ?? [],
    errors: { ...store.get().errors, calls: null },
  });
  return flat;
}
