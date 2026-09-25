import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJourneyData } from '../src/js/call-discovery.js';

const base = Date.parse('2026-09-25T10:00:00+02:00');
const time = (minutes) => new Date(base + minutes * 60000).toISOString();

function entry(journeyId, sequenceNumber, stopText, minutes, id, plannedMinutes = minutes) {
  return {
    stopText,
    call: {
      id,
      journeyId,
      sequenceNumber,
      lineId: 123,
      routeId: 456,
      destination: 'Centre',
      arrival: { forecastTime: time(minutes), plannedTime: time(plannedMinutes) },
    },
  };
}

test('retains ordered future stops while choosing the nearest future call for positions', () => {
  const { journeyVehicles, journeyStops } = buildJourneyData([
    entry(1, 3, 'Market (33)', 9, '3', 7),
    entry(1, 1, 'Depot (11)', -2, '1'),
    entry(1, 2, 'Square (22)', 4, '2', 3),
    entry(2, 1, 'Harbor (44)', 6, '4'),
  ], base);

  assert.deepEqual(journeyVehicles.get(1).callIds, ['2']);
  assert.deepEqual(journeyStops.get(1).map((stop) => stop.stopText), ['Square (22)', 'Market (33)']);
  assert.equal(journeyStops.get(1)[0].plannedTime, time(3));
  assert.deepEqual(journeyStops.get(2).map((stop) => stop.stopText), ['Harbor (44)']);
});

test('deduplicates reinforcement calls at a stop without losing their position IDs', () => {
  const { journeyVehicles, journeyStops } = buildJourneyData([
    entry(1, 1, 'Square (22)', 4, 'main'),
    entry(1, 1, 'Square (22)', 4, 'extra'),
    entry(1, 2, 'Market (33)', 9, 'next'),
  ], base);

  assert.deepEqual(journeyVehicles.get(1).callIds, ['main', 'extra']);
  assert.equal(journeyStops.get(1).length, 2);
});
