import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJourneyStops, isNextStopSoon } from '../src/js/live-vehicles.js';

test('buildJourneyStops maps each journey to its upcoming stops', () => {
  const stops = [{ stopText: 'A', sequenceNumber: 1, plannedTime: null, forecastTime: null }];
  const map = buildJourneyStops([
    { journeyId: 7, upcomingStops: stops },
    { journeyId: 8 },
    { journeyId: null, upcomingStops: stops },
  ]);
  assert.deepEqual([...map.keys()], [7, 8]);
  assert.equal(map.get(7), stops);
  assert.deepEqual(map.get(8), []);
});

test('isNextStopSoon hides buses whose next stop is over 10 minutes away', () => {
  const now = Date.parse('2026-01-01T10:00:00Z');
  const at = (minutes) => ({ nextStop: { forecastTime: new Date(now + minutes * 60000).toISOString() } });
  assert.equal(isNextStopSoon(at(5), now), true);
  assert.equal(isNextStopSoon(at(11), now), false);
  assert.equal(isNextStopSoon({ nextStop: null }, now), true);
});
