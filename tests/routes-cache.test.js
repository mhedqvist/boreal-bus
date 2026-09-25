import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/js/api.js';
import { store } from '../src/js/appState.js';
import { recordRouteIdsFromCalls } from '../src/js/routes.js';

test('concurrent route discoveries share one request and reuse cached geometry', async () => {
  const originalGetMapRoute = api.getMapRoute;
  let resolveRequest;
  let requests = 0;
  api.getMapRoute = () => {
    requests++;
    return new Promise((resolve) => { resolveRequest = resolve; });
  };

  try {
    const call = { lineId: 1, routeId: 456 };
    recordRouteIdsFromCalls([call]);
    recordRouteIdsFromCalls([call]);
    assert.equal(requests, 1);

    const geometry = { locations: [{ lat: 67.85, lon: 20.22 }] };
    resolveRequest(geometry);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.get().routeGeometry.get(456), geometry);

    recordRouteIdsFromCalls([call]);
    assert.equal(requests, 1);
  } finally {
    api.getMapRoute = originalGetMapRoute;
  }
});
