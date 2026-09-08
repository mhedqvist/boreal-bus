import { api } from './api.js';
import { store } from './appState.js';

export async function loadLines() {
  try {
    const lines = await api.getLines();
    // Default: every line active/visible.
    const activeLineIds = new Set(lines.map((line) => line.id));
    store.set({ lines, activeLineIds, errors: { ...store.get().errors, lines: null } });
    return lines;
  } catch (err) {
    store.set({ errors: { ...store.get().errors, lines: err.message } });
    return [];
  }
}
