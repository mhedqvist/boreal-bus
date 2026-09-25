import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../src/js/api.js';
import { store } from '../src/js/appState.js';
import { refreshStopsList, refreshCallDiscovery } from '../src/js/call-discovery.js';

test('a rate-limited stop scan keeps the previous journeys for the next retry', async () => {
  store.set({
    lines: [{ id: 1 }],
    journeyVehicles: new Map([[99, { callIds: ['previous'] }]]),
  });
  api.getStopAreas = async () => [{ id: 1, text: 'Square (1)' }, { id: 2, text: 'Market (2)' }];
  api.findStopArea = async (text) => ({ text, location: { lat: 67.85, lon: 20.22 } });
  api.getCalls = async ({ fromStopAreaQuery }) => {
    if (fromStopAreaQuery === 'Market (2)') {
      throw new ApiError('Rate limited', { status: 429 });
    }
    return { calls: [] };
  };
  await refreshStopsList();

  await assert.rejects(refreshCallDiscovery(), (error) => error.status === 429);
  assert.equal(store.get().journeyVehicles.get(99).callIds[0], 'previous');
});
