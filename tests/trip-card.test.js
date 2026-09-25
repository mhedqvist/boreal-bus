import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/js/appState.js';
import { initUi } from '../src/js/ui.js';

test('selected bus without more stops renders and refreshes without a disclosure', () => {
  const originalDocument = globalThis.document;
  let focusCount = 0;
  const container = {
    innerHTML: '',
    addEventListener() {},
    contains: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    focus: () => { focusCount++; },
  };
  globalThis.document = {
    activeElement: {
      closest: (selector) => selector === 'button[data-journey-id]'
        ? { dataset: { journeyId: '42' } }
        : null,
    },
    getElementById: (id) => id === 'live-buses' ? container : null,
  };

  try {
    const time = '2026-09-25T12:00:00Z';
    const bus = {
      journeyId: 42,
      lineId: 1,
      line: '1',
      destination: 'Kiruna',
      ageMs: 0,
      nextStop: { stopText: 'Center (1)', plannedTime: time, forecastTime: time },
      position: { timestamp: time },
    };
    store.set({
      activeLineIds: new Set([1]),
      liveVehicles: [bus],
      selectedVehicleJourneyId: 42,
      journeyStops: new Map([[42, [bus.nextStop]]]),
    });
    initUi();
    assert.match(container.innerHTML, /vehicle-card--expanded/);
    assert.match(container.innerHTML, /class="vehicle-trip"/);
    assert.doesNotMatch(container.innerHTML, /class="trip-more"/);

    store.set({ liveVehicles: [{ ...bus, ageMs: 1 }] });
    assert.match(container.innerHTML, /class="vehicle-trip"/);
    assert.ok(focusCount > 0);

    store.set({ selectedVehicleJourneyId: null });
    assert.doesNotMatch(container.innerHTML, /class="vehicle-trip"/);
  } finally {
    globalThis.document = originalDocument;
  }
});
