import { store } from './appState.js';

// Pure client-side UI state - no network call, mirroring filters.js's
// "toggling never triggers a refetch" pattern. Tracked by journeyId (see
// appState.js's comment on selectedVehicleJourneyId for why, not by
// liveVehicles[].key).
export function selectVehicle(journeyId) {
  const { selectedVehicleJourneyId } = store.get();
  store.set({ selectedVehicleJourneyId: selectedVehicleJourneyId === journeyId ? null : journeyId });
}

export function clearVehicleSelection() {
  store.set({ selectedVehicleJourneyId: null });
}
