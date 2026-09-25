// Narrow unit tests for commuter.js's pure helpers (no DOM/localStorage/
// geolocation involved, so these run under plain Node - no dependency or
// build step needed, consistent with the rest of the app).
//
// Run with: node --test src/js/commuter.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeFavoritesList,
  displayStopText,
  distanceLabel,
  haversineMeters,
  geolocationErrorMessage,
} from './commuter.js';

test('sanitizeFavoritesList keeps only non-empty strings, deduped in order', () => {
  assert.deepEqual(
    sanitizeFavoritesList(['Stadshustorget (84064)', '  ', 42, null, 'Stadshustorget (84064)', 'Bolagsomradet (84010)']),
    ['Stadshustorget (84064)', 'Bolagsomradet (84010)']
  );
});

test('sanitizeFavoritesList tolerates non-array input', () => {
  assert.deepEqual(sanitizeFavoritesList(null), []);
  assert.deepEqual(sanitizeFavoritesList('not-an-array'), []);
  assert.deepEqual(sanitizeFavoritesList(undefined), []);
});

test('displayStopText strips the trailing (id) suffix', () => {
  assert.equal(displayStopText('Stadshustorget (84064)'), 'Stadshustorget');
  assert.equal(displayStopText('No Id Here'), 'No Id Here');
  assert.equal(displayStopText(''), '');
  assert.equal(displayStopText(null), '');
});

test('haversineMeters returns ~0 for identical points and a plausible distance otherwise', () => {
  const a = { lat: 67.8558, lon: 20.2253 };
  assert.ok(haversineMeters(a, a) < 1e-6);

  // Roughly 1 degree of latitude is about 111km.
  const b = { lat: 68.8558, lon: 20.2253 };
  const meters = haversineMeters(a, b);
  assert.ok(meters > 100000 && meters < 112000, `expected ~111km, got ${meters}`);
});

test('distanceLabel formats meters vs kilometers and rejects bad input', () => {
  const origin = { lat: 67.8558, lon: 20.2253 };
  assert.equal(distanceLabel(origin, { lat: 67.8558, lon: 20.2253 }), '0 m');
  assert.equal(distanceLabel(origin, { lat: 68.8558, lon: 20.2253 }), '111.2 km');
  assert.equal(distanceLabel(origin, null), null);
  assert.equal(distanceLabel(origin, { lat: 'nope', lon: 20 }), null);
  assert.equal(distanceLabel(null, { lat: 67.86, lon: 20.23 }), null);
});

test('geolocationErrorMessage maps standard PositionError codes to explicit messages', () => {
  assert.match(geolocationErrorMessage({ code: 1 }), /denied/i);
  assert.match(geolocationErrorMessage({ code: 2 }), /could not be determined/i);
  assert.match(geolocationErrorMessage({ code: 3 }), /timed out/i);
  assert.match(geolocationErrorMessage({ code: 999 }), /could not get your current location/i);
  assert.match(geolocationErrorMessage(undefined), /could not get your current location/i);
});
