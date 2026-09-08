// Small pub/sub store. Not a framework dependency, just enough to let
// independent UI modules (map, arrivals list, filters) react to shared state.
export function createStore(initialState) {
  let state = { ...initialState };
  const listeners = new Set();

  function get() {
    return state;
  }

  function set(patch) {
    const prevState = state;
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    for (const listener of listeners) listener(state, prevState);
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { get, set, subscribe };
}
