import { getConfig } from './config.js';
import { store } from './appState.js';
import { selectStopsNearLocation, selectStopArea } from './stops.js';
import { colorForLineId } from './lineColors.js';

let map = null;
let vehicleLayer = null;
let routeLayer = null;
let stopMarker = null;
// Tracks the previously-applied vehicle selection so panning/opening the
// tooltip only happens once, right when the selection changes - not on
// every 15s re-render (which would otherwise yank the map view repeatedly
// while a bus stays selected).
let lastSelectedJourneyId = null;

// Kiruna, Sweden. GetConfigOptions' centerLat/centerLon were observed
// returning a generic Boreal default (Kongsberg, Norway) rather than a
// Kiruna-specific center, so the map always opens on Kiruna regardless of
// what the config response reports (see initial_plan.md).
const KIRUNA_CENTER = [67.8558, 20.2253];
const KIRUNA_ZOOM = 14;

// Assumes the global `L` (Leaflet, loaded via <script> in index.html - see
// initial_plan.md for why a CDN script tag was used instead of a bundler).
export function initMap(containerId) {
  const cfg = getConfig();
  const minZoom = cfg?.minZoom ?? 10;

  map = L.map(containerId, { minZoom }).setView(KIRUNA_CENTER, KIRUNA_ZOOM);

  const tileUrl = cfg?.tiles?.urlTemplate ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  L.tileLayer(tileUrl, { attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

  routeLayer = L.layerGroup().addTo(map);
  vehicleLayer = L.layerGroup().addTo(map);

  map.on('click', async (e) => {
    try {
      const stops = await selectStopsNearLocation({ lat: e.latlng.lat, lon: e.latlng.lng });
      if (stops?.length) {
        selectStopArea(stops[0]);
        placeStopMarker(stops[0]);
      }
    } catch {
      // Map-click stop lookup failing is non-fatal; search box still works.
    }
  });

  store.subscribe(render);
  render(store.get());
  return map;
}

function placeStopMarker(stop) {
  if (!stop?.location) return;
  if (stopMarker) map.removeLayer(stopMarker);
  stopMarker = L.marker([stop.location.lat, stop.location.lon]).addTo(map);
}

function render(state) {
  if (!map) return;
  renderRoutes(state);
  renderVehicles(state);
}

function renderRoutes(state) {
  routeLayer.clearLayers();
  for (const [lineId, routeIds] of state.lineRoutes.entries()) {
    if (!state.activeLineIds.has(lineId)) continue;
    const color = colorForLineId(lineId);
    for (const routeId of routeIds) {
      const geometry = state.routeGeometry.get(routeId);
      if (!geometry) continue; // still being discovered/fetched
      const latlngs = geometry.locations.map((loc) => [loc.lat, loc.lon]);
      L.polyline(latlngs, { color, weight: 4, opacity: 0.8 }).addTo(routeLayer);
    }
  }
}

function renderVehicles(state) {
  vehicleLayer.clearLayers();
  // Primary source: liveVehicles, built by live-vehicles.js from a
  // per-callId GetVehiclePosition scan across every call known town-wide
  // (call-discovery.js). Each entry already carries its line/destination,
  // so markers can be colored/labeled directly (see initial_plan.md - the
  // town-wide GetVehiclePositions endpoint itself was observed returning
  // no data even while buses were running).
  const selectedId = state.selectedVehicleJourneyId;
  // Only true on the render immediately following a selection change (not
  // every 15s poll tick while a bus stays selected) - used to pan/open the
  // tooltip once rather than repeatedly yanking the map/reopening it.
  const isNewSelection = selectedId != null && selectedId !== lastSelectedJourneyId;
  let selectedLatLng = null;

  for (const bus of state.liveVehicles) {
    if (bus.lineId !== undefined && !state.activeLineIds.has(bus.lineId)) continue;
    const { lat, lon } = bus.position.location;
    const color = bus.lineId !== undefined ? colorForLineId(bus.lineId) : '#888888';
    const isSelected = bus.journeyId != null && bus.journeyId === selectedId;
    const heading = bus.position.heading ?? 0;

    const arrowClasses = ['vehicle-arrow'];
    if (bus.stale) arrowClasses.push('vehicle-arrow--stale');
    const wrapperClasses = ['vehicle-icon-wrapper'];
    if (isSelected) wrapperClasses.push('vehicle-icon-wrapper--selected');
    const icon = L.divIcon({
      className: wrapperClasses.join(' '),
      html: `<div class="${arrowClasses.join(' ')}" style="transform: rotate(${heading}deg); border-bottom-color: ${color};"></div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

    const marker = L.marker([lat, lon], { icon });
    const nameLabel =
      bus.lineId !== undefined ? `${shortLineLabel(bus, state)} → ${bus.destination}` : `Bus (call ${bus.callIds[0]})`;
    const nextStopLabel = bus.nextStop?.stopText ? ` | next: ${bus.nextStop.stopText}` : '';
    const label = bus.stale ? `${nameLabel}${nextStopLabel} (stale, ${formatAge(bus.ageMs)} ago)` : `${nameLabel}${nextStopLabel}`;
    marker.bindTooltip(label, { direction: 'top' });
    marker.addTo(vehicleLayer);

    if (isSelected) {
      selectedLatLng = [lat, lon];
      if (isNewSelection) {
        marker.openTooltip();
        // Highlight (marker class) stays until deselected; only the
        // tooltip popup auto-dismisses, so it doesn't stay stuck open
        // and overlapping the map for as long as the bus is selected.
        setTimeout(() => marker.closeTooltip(), 3000);
      }
    }
  }

  if (selectedId !== lastSelectedJourneyId) {
    lastSelectedJourneyId = selectedId;
    if (isNewSelection && selectedLatLng) {
      map.panTo(selectedLatLng);
    }
  }
}

// Short display name (e.g. "Röd", trimming TransitCall.line's trailing
// period) rather than the long route-description Line.text, matching the
// table's Line column. Falls back to a Line.text lookup for older cached
// data that predates the `line` field, and finally a placeholder.
function shortLineLabel(bus, state) {
  if (bus.line) return bus.line.replace(/\.$/, '');
  if (bus.lineId !== undefined) return lineTextFor(state, bus.lineId);
  return '—';
}

function formatAge(ageMs) {
  if (ageMs == null || Number.isNaN(ageMs)) return '?';
  const minutes = Math.round(ageMs / 60000);
  return minutes < 1 ? '<1 min' : `${minutes} min`;
}

function lineTextFor(state, lineId) {
  return state.lines.find((l) => l.id === lineId)?.text ?? `Line ${lineId}`;
}
