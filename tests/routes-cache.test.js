import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/js/api.js';
import { store } from '../src/js/appState.js';
import { recordRouteIdsFromCalls } from '../src/js/routes.js';

const adolf = { lat: 67.86001, lon: 20.22105 };
const skradare = { lat: 67.86239, lon: 20.21577 };
const lkab = { lat: 67.84944, lon: 20.19584 };
const outbound = { locations: [adolf, { lat: 67.855, lon: 20.208 }, lkab] };
const returning = { locations: [lkab, skradare, adolf] };

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

test('LKAB-bound route fetches its return shape and caches the corrected approach', async () => {
  const originalGetMapRoute = api.getMapRoute;
  const requested = [];
  api.getMapRoute = (id) => {
    requested.push(id);
    return Promise.resolve(id === 540298 ? outbound : returning);
  };

  try {
    const call = { lineId: 110000548, routeId: 540298 };
    recordRouteIdsFromCalls([call]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requested.sort(), [535423, 540298]);
    assert.deepEqual(store.get().routeGeometry.get(540298).locations, [adolf, skradare, lkab]);
    assert.equal(store.get().errors.routes, null);
    recordRouteIdsFromCalls([call]);
    assert.equal(requested.length, 2);
  } finally {
    api.getMapRoute = originalGetMapRoute;
  }
});

test('missing return geometry reports an error and keeps the wrong outbound shape off the map', async () => {
  const originalGetMapRoute = api.getMapRoute;
  store.set({ routeGeometry: new Map(), errors: { ...store.get().errors, routes: null } });
  api.getMapRoute = (id) => id === 540298
    ? Promise.resolve(outbound)
    : Promise.reject(new Error('Route unavailable'));

  try {
    recordRouteIdsFromCalls([{ lineId: 110000548, routeId: 540298 }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.get().routeGeometry.has(540298), false);
    assert.match(store.get().errors.routes, /return-route geometry is unavailable/);

    api.getMapRoute = (id) => Promise.resolve(id === 540298 ? outbound : returning);
    recordRouteIdsFromCalls([{ lineId: 110000548, routeId: 540298 }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(store.get().routeGeometry.get(540298).locations, [adolf, skradare, lkab]);
    assert.equal(store.get().errors.routes, null);
  } finally {
    api.getMapRoute = originalGetMapRoute;
  }
});
