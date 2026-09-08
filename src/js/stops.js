import { api } from './api.js';
import { store } from './appState.js';
import { onStopSelected, onStopDeselected } from './poller.js';

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;

let debounceTimer = null;
let autocompleteAbort = null;
let requestSeq = 0;

// Debounced, stale-response-guarded autocomplete search.
export function searchStops(query, onResults) {
  clearTimeout(debounceTimer);
  requestSeq += 1;
  autocompleteAbort?.abort();
  autocompleteAbort = null;
  if (!query || query.trim().length < MIN_QUERY_LENGTH) {
    onResults([]);
    return;
  }
  debounceTimer = setTimeout(async () => {
    const mySeq = ++requestSeq;
    autocompleteAbort?.abort();
    autocompleteAbort = new AbortController();
    try {
      const results = await api.autocomplete(query.trim(), { signal: autocompleteAbort.signal });
      if (mySeq !== requestSeq) return; // a newer keystroke already superseded this
      onResults(results ?? []);
    } catch (err) {
      if (err.name === 'AbortError') return;
      onResults([]);
    }
  }, DEBOUNCE_MS);
}

export async function selectStopByText(stopText) {
  let stop;
  try {
    stop = await api.findStopArea(stopText);
  } catch (err) {
    store.set({ errors: { ...store.get().errors, stopNotFound: err.message } });
    return null;
  }
  if (!stop) {
    store.set({ errors: { ...store.get().errors, stopNotFound: `Stop "${stopText}" was not found.` } });
    return null;
  }
  selectStopArea(stop);
  return stop;
}

export async function selectStopsNearLocation(coordinate) {
  return api.findStopsNearLocation(coordinate, { maxCount: 5 });
}

export function selectStopArea(stop) {
  store.set({ selectedStop: stop, errors: { ...store.get().errors, stopNotFound: null } });
  onStopSelected();
}

export function clearSelectedStop() {
  store.set({ selectedStop: null });
  onStopDeselected();
}
