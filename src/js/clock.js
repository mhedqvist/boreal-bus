import { api } from './api.js';
import { store } from './appState.js';

// One-time client/server clock offset so countdowns aren't skewed by the
// visitor's system clock.
export async function initClockOffset() {
  try {
    const clientTimestamp = new Date().toISOString();
    const resp = await api.getSystemTimestamp(clientTimestamp);
    const serverTime = new Date(resp.systemTimestamp).getTime();
    const clientTime = new Date(resp.clientTimestamp).getTime();
    store.set({ clockOffsetMs: serverTime - clientTime });
  } catch {
    store.set({ clockOffsetMs: 0 });
  }
}

export function now() {
  return Date.now() + store.get().clockOffsetMs;
}

const STOCKHOLM_TZ = 'Europe/Stockholm';

// Times are formatted (and delays computed) from parsed instants, never from
// display strings, and pinned to Europe/Stockholm regardless of the
// visitor's own timezone.
export function formatTime(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: STOCKHOLM_TZ,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function minutesUntil(isoString) {
  if (!isoString) return null;
  const target = new Date(isoString).getTime();
  if (Number.isNaN(target)) return null;
  return Math.round((target - now()) / 60000);
}
