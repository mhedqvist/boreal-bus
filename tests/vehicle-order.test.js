import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/js/appState.js';
import { initUi } from '../src/js/ui.js';

test('live buses stay grouped by line color and journey as ETAs change', () => {
  const originalDocument = globalThis.document;
  const container = {
    innerHTML: '',
    addEventListener() {},
    contains: () => false,
    querySelector: () => null,
  };
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => id === 'live-buses' ? container : null,
  };

  try {
    const lines = [
      { id: 1, text: 'Röd' },
      { id: 2, text: 'Gul' },
      { id: 3, text: 'Grön' },
      { id: 4, text: 'Lila' },
    ];
    const bus = (journeyId, lineId, time) => ({
      journeyId,
      lineId,
      destination: `Bus ${journeyId}`,
      ageMs: 0,
      position: { timestamp: time },
      nextStop: { stopText: 'Center (1)', forecastTime: time },
    });
    const vehicles = [
      bus(40, 1, '2026-09-25T08:00:00Z'),
      bus(31, 3, '2026-09-25T08:10:00Z'),
      bus(20, 2, '2026-09-25T08:20:00Z'),
      bus(30, 3, '2026-09-25T08:30:00Z'),
      bus(50, 4, '2026-09-25T08:40:00Z'),
    ];
    const displayedJourneys = () => [...container.innerHTML.matchAll(/<button\b[^>]*data-journey-id="(\d+)"/g)]
      .map((match) => Number(match[1]));

    store.set({ lines, activeLineIds: new Set(lines.map((line) => line.id)), liveVehicles: vehicles });
    initUi();
    assert.deepEqual(displayedJourneys(), [30, 31, 20, 50, 40]);

    store.set({
      liveVehicles: [...vehicles].reverse().map((vehicle, index) => ({
        ...vehicle,
        nextStop: { ...vehicle.nextStop, forecastTime: `2026-09-25T09:0${index}:00Z` },
      })),
    });
    assert.deepEqual(displayedJourneys(), [30, 31, 20, 50, 40]);
  } finally {
    globalThis.document = originalDocument;
  }
});
