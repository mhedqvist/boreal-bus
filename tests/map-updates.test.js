import test from 'node:test';
import assert from 'node:assert/strict';
import { initMap } from '../src/js/map.js';
import { store } from '../src/js/appState.js';

test('moves existing bus markers without rebuilding unchanged routes and stops', () => {
  const markers = [];
  const groups = [];
  const routes = [];
  const circles = [];
  const map = {
    setView() { return this; },
    on() {},
    panTo(position) { this.lastPan = position; },
  };
  globalThis.window = { addEventListener() {} };
  globalThis.document = {
    getElementById() { return {}; },
    querySelector() { return null; },
    createElement() { return { textContent: '' }; },
  };
  globalThis.L = {
    map() { return map; },
    tileLayer() { return { addTo() {} }; },
    layerGroup() {
      const group = {
        clearCount: 0,
        removed: [],
        addTo() { return this; },
        clearLayers() { this.clearCount++; },
        removeLayer(layer) { this.removed.push(layer); },
      };
      groups.push(group);
      return group;
    },
    divIcon(options) { return options; },
    circleMarker(position, options) {
      circles.push(options);
      return { bindTooltip() { return this; }, on() { return this; }, addTo() { return this; } };
    },
    polyline(position, options) {
      const polyline = {
        position,
        options,
        addCount: 0,
        addTo() { this.addCount++; return this; },
        setStyle(style) { this.options = { ...this.options, ...style }; },
      };
      routes.push(polyline);
      return polyline;
    },
    marker(position, options) {
      const marker = {
        position,
        icon: options.icon,
        bindTooltip() { return this; },
        on() { return this; },
        addTo() { return this; },
        setLatLng(next) { this.position = next; },
        setIcon(next) { this.icon = next; },
        setTooltipContent() {},
        openTooltip() {},
        closeTooltip() {},
      };
      markers.push(marker);
      return marker;
    },
  };

  initMap('map');
  const bus = {
    journeyId: 7,
    lineId: 123,
    routeId: 456,
    line: 'Röd.',
    destination: 'Centre',
    callIds: ['c1'],
    ageMs: 0,
    stale: false,
    nextStop: { stopText: 'Square (22)' },
    position: { location: { lat: 67.85, lon: 20.22 }, heading: 90, timestamp: '2026-09-25T10:00:00+02:00' },
  };
  store.set({
    activeLineIds: new Set([123]),
    lineRoutes: new Map([[123, new Set([456])]]),
    routeGeometry: new Map([[456, { locations: [{ lat: 67.85, lon: 20.22 }, { lat: 67.86, lon: 20.23 }] }]]),
    stopLocations: new Map([[22, { text: 'Square (22)', location: { lat: 67.86, lon: 20.23 } }]]),
    liveVehicles: [bus],
  });

  const [routeLayer, stopLayer] = groups;
  const routeRenders = routeLayer.clearCount;
  const stopRenders = stopLayer.clearCount;
  const originalRoute = routes[0];
  const marker = markers[0];
  store.set({ liveVehicles: [{ ...bus, position: { ...bus.position, location: { lat: 67.851, lon: 20.221 } } }] });

  assert.equal(markers.length, 1);
  assert.deepEqual(marker.position, [67.851, 20.221]);
  assert.equal(routeLayer.clearCount, routeRenders);
  assert.equal(stopLayer.clearCount, stopRenders);
  assert.equal(routes.length, 1);

  store.set({
    selectedVehicleJourneyId: 7,
    journeyStops: new Map([[7, [{ stopText: 'Square (22)', sequenceNumber: 1 }]]]),
  });
  assert.equal(routes.length, 1);
  assert.equal(originalRoute.options.weight, 7);
  assert.equal(circles.at(-1).radius, 6);
  assert.deepEqual(map.lastPan, [67.851, 20.221]);

  store.set({ activeLineIds: new Set() });
  assert.equal(routes.length, 1);
  assert.deepEqual(routeLayer.removed, [originalRoute]);
  store.set({ activeLineIds: new Set([123]) });
  assert.equal(routes.length, 1);
  assert.equal(originalRoute.addCount, 2);
  assert.equal(originalRoute.options.weight, 7);

  store.set({
    routeGeometry: new Map([
      [456, store.get().routeGeometry.get(456)],
      [789, { locations: [{ lat: 67.85, lon: 20.22 }, { lat: 67.87, lon: 20.24 }] }],
    ]),
    lineRoutes: new Map([[123, new Set([456, 789])]]),
  });
  assert.equal(routes.length, 2);
  assert.equal(routes[0], originalRoute);
  assert.equal(routeLayer.clearCount, routeRenders);

  store.set({
    routeGeometry: new Map([
      [456, { locations: [{ lat: 67.85, lon: 20.22 }, { lat: 67.88, lon: 20.25 }] }],
      [789, store.get().routeGeometry.get(789)],
    ]),
  });
  assert.equal(routes.length, 3);
  assert.deepEqual(routeLayer.removed, [originalRoute, originalRoute]);

  store.set({
    selectedStop: { id: 22, text: 'Square (22)', location: { lat: 67.86, lon: 20.23 } },
    stopSelectionSeq: 1,
  });
  assert.deepEqual(map.lastPan, [67.86, 20.23]);
});
