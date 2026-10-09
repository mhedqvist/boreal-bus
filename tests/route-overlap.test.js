import test from 'node:test';
import assert from 'node:assert/strict';
import { routePartsForVisibleRoutes } from '../src/js/routeOverlap.js';

test('shared road segments get stable lanes while unique stretches remain unchanged', () => {
  const points = Array.from({ length: 6 }, (_, i) => ({ lat: 67.85 + i * 0.0001, lon: 20.22 + i * 0.0002 }));
  const routes = [
    { key: 'yellow', color: '#f9a825', geometry: { locations: points } },
    { key: 'purple', color: '#7b1fa2', geometry: { locations: points.slice(0, 5).reverse() } },
    { key: 'red', color: '#c62828', geometry: { locations: points.slice(1, 4) } },
  ];
  const layout = routePartsForVisibleRoutes(routes);
  const yellow = layout[0].parts;
  assert.equal(yellow.find((part) => !part.shared).paths.length, 1);
  assert.deepEqual(yellow.find((part) => !part.shared).paths[0], [
    [points[4].lat, points[4].lon], [points[5].lat, points[5].lon],
  ]);

  const triple = layout.map((route) => route.parts.find((part) => part.key.split(':')[0].split(',').length === 3));
  assert.deepEqual(triple.map((part) => part.laneIndex).sort((a, b) => a - b), [-1, 0, 1]);
  assert.deepEqual(triple[0].paths, triple[1].paths);
  assert.deepEqual(triple[1].paths, triple[2].paths);

  const filtered = routePartsForVisibleRoutes([routes[0]]);
  assert.deepEqual(filtered[0].parts.map((part) => part.shared), [false]);
  assert.equal(filtered[0].parts[0].laneIndex, 0);
});

test('overlapping route variants with the same color stay centered', () => {
  const locations = [{ lat: 67.85, lon: 20.22 }, { lat: 67.86, lon: 20.23 }];
  const routes = [
    { key: 'outbound', color: '#f9a825', geometry: { locations } },
    { key: 'inbound', color: '#f9a825', geometry: { locations: [...locations].reverse() } },
  ];
  assert.deepEqual(routePartsForVisibleRoutes(routes).map((route) => route.parts[0].shared), [false, false]);
  assert.deepEqual(routePartsForVisibleRoutes(routes).map((route) => route.parts[0].laneIndex), [0, 0]);
});
