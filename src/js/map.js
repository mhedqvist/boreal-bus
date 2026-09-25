import { getConfig } from './config.js';
import { store } from './appState.js';
import { selectStopsNearLocation, selectStopArea } from './stops.js';
import { colorForLineId } from './lineColors.js';
import { headingAlongRoute } from './routeHeading.js';
import { routePartsForVisibleRoutes } from './routeOverlap.js';
import { selectVehicle } from './vehicleSelection.js';

let map = null;
let vehicleLayer = null;
let routeLayer = null;
let stopLayer = null;
let stopMarker = null;
let stopMarkerId = null;
let mapResizeObserver = null;
let resizeFrame = null;
const vehicleMarkers = new Map();
const routePolylines = new Map();
let lastRenderedRouteId = null;
let lastRenderedUpcomingKey = '';
// Tracks the previously-applied vehicle selection so panning/opening the
// tooltip only happens once, right when the selection changes - not on
// every 15s re-render (which would otherwise yank the map view repeatedly
// while a bus stays selected).
let lastSelectedJourneyId = null;

// Kiruna, Sweden. GetConfigOptions' centerLat/centerLon were observed
// returning a generic Boreal default (Kongsberg, Norway) rather than a
// Kiruna-specific center, so the map always opens on Kiruna regardless of
// what the config response reports (see docs/initial_plan.md).
const KIRUNA_CENTER = [67.8558, 20.2253];
const KIRUNA_ZOOM = 14;

// Assumes the global `L` (Leaflet, loaded via <script> in index.html - see
// docs/initial_plan.md for why a CDN script tag was used instead of a bundler).
export function initMap(containerId) {
  const cfg = getConfig();
  const minZoom = cfg?.minZoom ?? 10;

  map = L.map(containerId, { minZoom }).setView(KIRUNA_CENTER, KIRUNA_ZOOM);

  const tileUrl = cfg?.tiles?.urlTemplate ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  L.tileLayer(tileUrl, { attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

  routeLayer = L.layerGroup().addTo(map);
  routePolylines.clear();
  stopLayer = L.layerGroup().addTo(map);
  vehicleLayer = L.layerGroup().addTo(map);

  observeMapSize(document.getElementById(containerId));

  map.on('click', async (e) => {
    try {
      const stops = await selectStopsNearLocation({ lat: e.latlng.lat, lon: e.latlng.lng });
      if (stops?.length) {
        selectStopArea(stops[0]);
      }
    } catch {
      // Map-click stop lookup failing is non-fatal; search box still works.
    }
  });

  store.subscribe(render);
  render(store.get());
  return map;
}

function observeMapSize(container) {
  if (!container) return;

  const invalidateSize = () => {
    if (resizeFrame != null) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      map?.invalidateSize({ pan: false });
    });
  };

  if ('ResizeObserver' in window) {
    mapResizeObserver = new ResizeObserver(invalidateSize);
    mapResizeObserver.observe(container);
  } else {
    window.addEventListener('resize', invalidateSize);
  }
  window.addEventListener('orientationchange', invalidateSize);
}

function render(state, prev) {
  if (!map) return;
  const selectedRouteId = state.selectedVehicleJourneyId == null
    ? null
    : state.liveVehicles.find((bus) => bus.journeyId === state.selectedVehicleJourneyId)?.routeId ?? null;
  if (!prev || state.lineRoutes !== prev.lineRoutes || state.routeGeometry !== prev.routeGeometry ||
      state.activeLineIds !== prev.activeLineIds || state.lines !== prev.lines ||
      state.selectedVehicleJourneyId !== prev.selectedVehicleJourneyId ||
      selectedRouteId !== lastRenderedRouteId) {
    renderRoutes(state, selectedRouteId);
    lastRenderedRouteId = selectedRouteId;
  }
  const upcomingKey = (state.journeyStops.get(state.selectedVehicleJourneyId) ?? [])
    .map((stop) => stop.stopText).join('|');
  if (!prev || state.stopLocations !== prev.stopLocations || state.selectedStop !== prev.selectedStop ||
      upcomingKey !== lastRenderedUpcomingKey) {
    renderStops(state);
    lastRenderedUpcomingKey = upcomingKey;
  }
  if (!prev || state.stopSelectionSeq !== prev.stopSelectionSeq) renderSelectedStop(state);
  if (!prev || state.liveVehicles !== prev.liveVehicles || state.activeLineIds !== prev.activeLineIds ||
      state.selectedVehicleJourneyId !== prev.selectedVehicleJourneyId ||
      state.routeGeometry !== prev.routeGeometry || state.stopLocations !== prev.stopLocations ||
      state.lines !== prev.lines) renderVehicles(state);
}

function renderSelectedStop(state) {
  if (stopMarker) map.removeLayer(stopMarker);
  stopMarker = null;
  stopMarkerId = null;
  const stop = state.selectedStop;
  const hint = document.querySelector('.map-instruction');
  if (hint) hint.hidden = !!stop;
  if (!stop) return;
  const location = stop.location ?? state.stopLocations.get(stop.id)?.location ??
    locationForStopText(state, stop.text);
  if (!location) return;
  if (!state.stopLocations.has(stop.id)) {
    stopMarker = L.marker([location.lat, location.lon]).addTo(map);
    stopMarkerId = stop.id;
  }
  map.panTo([location.lat, location.lon]);
}

// Every stop served by any line, drawn as a small circle. Coordinates come
// from state.stopLocations (resolved via FindStopArea in call-discovery.js,
// since GetStopAreas omits them). Clicking a circle selects that stop
// directly - the circle would otherwise swallow the map's click handler,
// which resolves a stop via FindStopsNearLocation.
function renderStops(state) {
  if (stopMarker && state.stopLocations.has(stopMarkerId)) {
    map.removeLayer(stopMarker);
    stopMarker = null;
    stopMarkerId = null;
  }
  stopLayer.clearLayers();
  const selectedId = state.selectedStop?.id;
  const upcoming = new Set((state.journeyStops.get(state.selectedVehicleJourneyId) ?? []).map((stop) => stop.stopText));
  for (const [stopId, entry] of state.stopLocations.entries()) {
    const isSelected = stopId === selectedId;
    const isUpcoming = upcoming.has(entry.text);
    const circle = L.circleMarker([entry.location.lat, entry.location.lon], {
      radius: isSelected ? 7 : isUpcoming ? 6 : 4,
      color: '#ffffff',
      weight: 2,
      fillColor: isSelected ? '#1a5fb4' : isUpcoming ? '#b45309' : '#444444',
      fillOpacity: 1,
      bubblingMouseEvents: false,
    });
    circle.bindTooltip(textTooltip(entry.text), { direction: 'top' });
    circle.on('click', () => selectStopArea({ id: stopId, text: entry.text, location: entry.location }));
    circle.addTo(stopLayer);
  }
}

function renderRoutes(state, selectedRouteId) {
  const known = new Set();
  const visible = new Set();
  const routes = [];
  for (const [lineId, routeIds] of state.lineRoutes.entries()) {
    for (const routeId of routeIds) {
      const geometry = state.routeGeometry.get(routeId);
      if (!geometry) continue; // still being discovered/fetched
      const key = `${lineId}:${routeId}`;
      known.add(key);
      if (!state.activeLineIds.has(lineId)) continue;
      visible.add(key);
      routes.push({ key, routeId, geometry, color: colorForLineId(lineId) });
    }
  }
  for (const route of routePartsForVisibleRoutes(routes)) {
    const { key, geometry, color, layoutKey } = route;
    const selected = state.selectedVehicleJourneyId != null && route.routeId === selectedRouteId;
    const styleFor = (part) => ({
      color,
      weight: selected ? 7 : 4,
      opacity: selected ? 1 : 0.8,
      ...(part.shared ? { dashArray: part.dashArray, dashOffset: part.dashOffset, lineCap: 'butt' } : {}),
    });
    let entry = routePolylines.get(key);
    if (!entry || entry.geometry !== geometry || entry.layoutKey !== layoutKey) {
      if (entry?.visible) entry.polylines.forEach((polyline) => routeLayer.removeLayer(polyline));
      entry = {
        polylines: route.parts.map((part) => L.polyline(part.paths, styleFor(part)).addTo(routeLayer)),
        geometry, layoutKey, color, selected, visible: true,
      };
      routePolylines.set(key, entry);
    } else {
      if (!entry.visible) {
        entry.polylines.forEach((polyline) => polyline.addTo(routeLayer));
        entry.visible = true;
      }
      if (entry.color !== color || entry.selected !== selected) {
        entry.polylines.forEach((polyline, i) => polyline.setStyle(styleFor(route.parts[i])));
        entry.color = color;
        entry.selected = selected;
      }
    }
  }
  for (const [key, entry] of routePolylines) {
    if (visible.has(key)) continue;
    if (entry.visible) {
      entry.polylines.forEach((polyline) => routeLayer.removeLayer(polyline));
      entry.visible = false;
    }
    if (!known.has(key)) routePolylines.delete(key);
  }
}

function renderVehicles(state) {
  // Primary source: liveVehicles, built by live-vehicles.js from a
  // per-callId GetVehiclePosition scan across every call known town-wide
  // (call-discovery.js). Each entry already carries its line/destination,
  // so markers can be colored/labeled directly (see docs/initial_plan.md - the
  // town-wide GetVehiclePositions endpoint itself was observed returning
  // no data even while buses were running).
  const selectedId = state.selectedVehicleJourneyId;
  // Only true on the render immediately following a selection change (not
  // every 15s poll tick while a bus stays selected) - used to pan/open the
  // tooltip once rather than repeatedly yanking the map/reopening it.
  const isNewSelection = selectedId != null && selectedId !== lastSelectedJourneyId;
  let selectedLatLng = null;
  const seen = new Set();
  const journeyCounts = new Map();
  for (const bus of state.liveVehicles) {
    if (bus.journeyId != null) journeyCounts.set(bus.journeyId, (journeyCounts.get(bus.journeyId) ?? 0) + 1);
  }

  for (const bus of state.liveVehicles) {
    if (bus.lineId !== undefined && !state.activeLineIds.has(bus.lineId)) continue;
    const key = bus.journeyId != null && journeyCounts.get(bus.journeyId) === 1
      ? `journey:${bus.journeyId}`
      : `call:${bus.callIds[0] ?? bus.key}`;
    seen.add(key);
    const { lat, lon } = bus.position.location;
    const color = bus.lineId !== undefined ? colorForLineId(bus.lineId) : '#888888';
    const isSelected = bus.journeyId != null && bus.journeyId === selectedId;
    const reportedHeading = bus.position.heading;
    const nextStopLocation = locationForStopText(state, bus.nextStop?.stopText);
    const heading = reportedHeading != null && Number.isFinite(Number(reportedHeading))
      ? Number(reportedHeading)
      : headingAlongRoute(bus.position.location, state.routeGeometry.get(bus.routeId), nextStopLocation);

    const markerClasses = [heading == null ? 'vehicle-dot' : 'vehicle-arrow'];
    if (bus.stale) markerClasses.push(heading == null ? 'vehicle-dot--stale' : 'vehicle-arrow--stale');
    const wrapperClasses = ['vehicle-icon-wrapper'];
    if (isSelected) wrapperClasses.push('vehicle-icon-wrapper--selected');
    const markerStyle = heading == null
      ? `background-color: ${color};`
      : `transform: rotate(${heading}deg); border-bottom-color: ${color};`;
    const iconKey = `${wrapperClasses.join(' ')}|${markerClasses.join(' ')}|${markerStyle}`;
    const nameLabel =
      bus.lineId !== undefined ? `${shortLineLabel(bus, state)} → ${bus.destination}` : `Bus (call ${bus.callIds[0]})`;
    const nextStopLabel = bus.nextStop?.stopText ? ` | next: ${bus.nextStop.stopText}` : '';
    const label = bus.stale ? `${nameLabel}${nextStopLabel} (stale, ${formatAge(bus.ageMs)} ago)` : `${nameLabel}${nextStopLabel}`;
    let entry = vehicleMarkers.get(key);
    if (!entry) {
      const marker = L.marker([lat, lon], { icon: vehicleIcon(wrapperClasses, markerClasses, markerStyle) });
      marker.bindTooltip(textTooltip(label), { direction: 'top' });
      if (bus.journeyId != null) marker.on('click', () => selectVehicle(bus.journeyId));
      marker.addTo(vehicleLayer);
      entry = { marker, iconKey, label };
      vehicleMarkers.set(key, entry);
    } else {
      entry.marker.setLatLng([lat, lon]);
      if (entry.iconKey !== iconKey) {
        entry.marker.setIcon(vehicleIcon(wrapperClasses, markerClasses, markerStyle));
        entry.iconKey = iconKey;
      }
      if (entry.label !== label) {
        entry.marker.setTooltipContent(textTooltip(label));
        entry.label = label;
      }
    }

    if (isSelected) {
      selectedLatLng = [lat, lon];
      if (isNewSelection) {
        entry.marker.openTooltip();
        // Highlight (marker class) stays until deselected; only the
        // tooltip popup auto-dismisses, so it doesn't stay stuck open
        // and overlapping the map for as long as the bus is selected.
        setTimeout(() => entry.marker.closeTooltip(), 3000);
      }
    }
  }

  for (const [key, entry] of vehicleMarkers) {
    if (seen.has(key)) continue;
    vehicleLayer.removeLayer(entry.marker);
    vehicleMarkers.delete(key);
  }

  if (selectedId !== lastSelectedJourneyId) {
    lastSelectedJourneyId = selectedId;
    if (isNewSelection && selectedLatLng) {
      map.panTo(selectedLatLng);
    }
  }
}

function vehicleIcon(wrapperClasses, markerClasses, markerStyle) {
  return L.divIcon({
    className: wrapperClasses.join(' '),
    html: `<div class="${markerClasses.join(' ')}" style="${markerStyle}"></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

// Short display name (e.g. "Röd", trimming TransitCall.line's trailing
// period) rather than the long route-description Line.text, matching the
// bus card's line badge. Falls back to a Line.text lookup for older cached
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

function locationForStopText(state, stopText) {
  if (!stopText) return null;
  for (const stop of state.stopLocations.values()) {
    if (stop.text === stopText) return stop.location;
  }
  return null;
}

function textTooltip(text) {
  const element = document.createElement('span');
  element.textContent = text ?? '';
  return element;
}
