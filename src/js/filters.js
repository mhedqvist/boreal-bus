import { store } from './appState.js';
import { ensureLineRouteDiscovered } from './routes.js';

// Toggling never triggers a calls/vehicles refetch by itself - it only
// changes which cached data renders. The one exception: enabling a line
// whose route geometry is still unknown kicks off a lazy discovery probe.
export function toggleLine(lineId) {
  const { activeLineIds } = store.get();
  const next = new Set(activeLineIds);
  if (next.has(lineId)) {
    next.delete(lineId);
  } else {
    next.add(lineId);
    ensureLineRouteDiscovered(lineId);
  }
  store.set({ activeLineIds: next });
}

export function isLineActive(lineId) {
  return store.get().activeLineIds.has(lineId);
}
