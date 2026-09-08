import { store } from './appState.js';
import { toggleLine } from './filters.js';
import { searchStops, selectStopByText, clearSelectedStop } from './stops.js';
import { formatTime, minutesUntil } from './clock.js';
import { colorForLineId } from './lineColors.js';
import { selectVehicle } from './vehicleSelection.js';

const TABLE_MAX_POSITION_AGE_MS = 15 * 60 * 1000;

export function initUi() {
  wireSearch();
  wireVehicleTableClicks();
  store.subscribe((state) => {
    renderLineFilters(state);
    renderVehiclesTable(state);
    renderArrivals(state);
    renderStatus(state);
  });
  renderLineFilters(store.get());
  renderVehiclesTable(store.get());
  renderArrivals(store.get());
  renderStatus(store.get());
}

// Delegated once at startup (rather than rebound on every render, since
// renderVehiclesTable rewrites the table's innerHTML on every poll tick).
function wireVehicleTableClicks() {
  const container = document.getElementById('live-buses');
  if (!container) return;
  container.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-journey-id]');
    if (!row) return;
    selectVehicle(Number(row.dataset.journeyId));
  });
}

function renderVehiclesTable(state) {
  const container = document.getElementById('live-buses');
  if (!container) return;

  // Primary source: liveVehicles (from live-vehicles.js's per-callId scan
  // across every known call town-wide), one row per distinct physical bus.
  const visibleVehicles = state.liveVehicles.filter(
    (bus) =>
      (bus.lineId === undefined || state.activeLineIds.has(bus.lineId)) &&
      (bus.ageMs == null || Number.isNaN(bus.ageMs) || bus.ageMs <= TABLE_MAX_POSITION_AGE_MS)
  );

  if (!visibleVehicles.length) {
    container.innerHTML = '<h2>Live buses</h2><p class="hint">No live bus positions right now.</p>';
    return;
  }

  const staleCount = visibleVehicles.filter((b) => b.stale).length;
  const subtitle = staleCount
    ? `<p class="hint">${staleCount} of ${visibleVehicles.length} haven't reported a new position in a while (see Status column) - the API has no explicit "in service" flag, so this is inferred from position age.</p>`
    : '';

  const parts = [
    `<h2>Live buses (${visibleVehicles.length})</h2>`,
    subtitle,
    '<table class="arrivals-table"><thead><tr><th>Line</th><th>Destination</th><th>Next stop</th><th>Planned</th><th>Expected</th><th>Occupancy</th><th>Updated</th><th>Status</th></tr></thead><tbody>',
  ];
  for (const bus of visibleVehicles) {
    // Short display name (e.g. "Röd", trimming TransitCall.line's trailing
    // period), not the long route-description Line.text.
    const lineText = bus.line ? bus.line.replace(/\.$/, '') : bus.lineId !== undefined ? lineTextFor(state, bus.lineId) : '—';
    const color = bus.lineId !== undefined ? colorForLineId(bus.lineId) : '#888888';
    const destination = bus.destination ?? '—';
    const status = bus.stale
      ? `<span class="status-stale">Stale (${formatAge(bus.ageMs)} ago)</span>`
      : '<span class="status-live">Live</span>';
    const nextStopText = bus.nextStop?.stopText ?? '—';
    const planned = formatTime(bus.nextStop?.plannedTime);
    const expected = formatTime(bus.nextStop?.forecastTime);
    const occupancy = bus.nextStop?.occupancyPercent != null ? `${Math.round(bus.nextStop.occupancyPercent)}%` : '—';
    const rowClasses = [bus.stale ? 'row-stale' : '', bus.journeyId === state.selectedVehicleJourneyId ? 'row-selected' : '']
      .filter(Boolean)
      .join(' ');
    parts.push(`<tr class="${rowClasses}" data-journey-id="${bus.journeyId ?? ''}">
      <td><span class="line-badge" style="background:${color};color:#ffffff">${escapeHtml(lineText)}</span></td>
      <td>${escapeHtml(destination)}</td>
      <td>${escapeHtml(nextStopText)}</td>
      <td>${planned}</td>
      <td>${expected}</td>
      <td>${occupancy}</td>
      <td>${formatTime(bus.position.timestamp)}</td>
      <td>${status}</td>
    </tr>`);
  }
  parts.push('</tbody></table>');
  container.innerHTML = parts.join('');
}

function formatAge(ageMs) {
  if (ageMs == null || Number.isNaN(ageMs)) return '?';
  const minutes = Math.round(ageMs / 60000);
  return minutes < 1 ? '<1 min' : `${minutes} min`;
}

function lineTextFor(state, lineId) {
  return state.lines.find((l) => l.id === lineId)?.text ?? `Line ${lineId}`;
}

function renderLineFilters(state) {
  const container = document.getElementById('line-filters');
  if (!container) return;

  const html = state.lines
    .map((line) => {
      const checked = state.activeLineIds.has(line.id) ? 'checked' : '';
      return `<label class="line-filter"><input type="checkbox" data-line-id="${line.id}" ${checked}> ${escapeHtml(line.text)}</label>`;
    })
    .join('');

  // Avoid tearing down/rebuilding (and re-attaching listeners) on every poll
  // tick when the line list itself hasn't changed.
  if (container.dataset.rendered === html) return;
  container.dataset.rendered = html;
  container.innerHTML = html;
  container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => toggleLine(Number(input.dataset.lineId)));
  });
}

function wireSearch() {
  const input = document.getElementById('stop-search');
  const results = document.getElementById('stop-search-results');
  const clearBtn = document.getElementById('stop-clear');
  if (!input || !results) return;

  input.addEventListener('input', () => {
    searchStops(input.value, (matches) => {
      results.innerHTML = matches
        .map((text) => `<li data-text="${escapeHtml(text)}">${escapeHtml(text)}</li>`)
        .join('');
    });
  });

  results.addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-text]');
    if (!li) return;
    input.value = li.dataset.text;
    results.innerHTML = '';
    await selectStopByText(li.dataset.text);
  });

  clearBtn?.addEventListener('click', () => {
    input.value = '';
    results.innerHTML = '';
    clearSelectedStop();
  });
}

function renderArrivals(state) {
  const container = document.getElementById('arrivals');
  if (!container) return;

  if (!state.selectedStop) {
    container.innerHTML = '<p class="hint">Search for a stop (or click the map) to see arrivals.</p>';
    return;
  }

  const parts = [`<h2>${escapeHtml(state.selectedStop.text)}</h2>`];

  if (state.isStopCancelled) {
    parts.push('<p class="banner banner-cancelled">All departures at this stop are cancelled.</p>');
  }

  // Split messages into ones targeting specific calls vs. line-level notices.
  const affectedByCallId = new Map();
  const lineLevelMessages = [];
  for (const message of state.messages) {
    if (message.affectedCalls?.length) {
      for (const callId of message.affectedCalls) {
        const list = affectedByCallId.get(callId) ?? [];
        list.push(message);
        affectedByCallId.set(callId, list);
      }
    } else {
      lineLevelMessages.push(message);
    }
  }
  for (const message of lineLevelMessages) {
    const kind = message.isDisturbance ? 'banner-disturbance' : 'banner-info';
    parts.push(`<p class="banner ${kind}">${escapeHtml(message.text)}</p>`);
  }

  const visibleCalls = state.calls.filter((call) => state.activeLineIds.has(call.lineId));

  if (!visibleCalls.length) {
    parts.push('<p class="hint">No departures right now.</p>');
  } else {
    parts.push(
      '<table class="arrivals-table"><thead><tr><th>Line</th><th>Destination</th><th>Planned</th><th>Forecast</th><th>Quality</th></tr></thead><tbody>'
    );
    for (const call of visibleCalls) {
      const forecast = call.departure ?? call.arrival;
      const affected = affectedByCallId.get(call.id) ?? [];
      const delayMin = forecast ? minutesUntil(forecast.forecastTime) : null;
      // Derived from the line name, not TransitCall.lineAppearance (the API's
      // own appearance colors were observed unreliable - see initial_plan.md
      // and lineColors.js).
      const bg = colorForLineId(call.lineId);
      const fg = '#ffffff';
      parts.push(`<tr>
        <td><span class="line-badge" style="background:${bg};color:${fg}">${escapeHtml(call.line)}</span></td>
        <td>${escapeHtml(call.destination)}</td>
        <td>${forecast ? formatTime(forecast.plannedTime) : '—'}</td>
        <td>${forecast ? `${formatTime(forecast.forecastTime)}${delayMin !== null ? ` (${delayMin} min)` : ''}` : '—'}</td>
        <td>${forecast ? escapeHtml(forecast.quality) : '—'}</td>
      </tr>`);
      if (affected.length) {
        parts.push(
          `<tr class="message-row"><td colspan="5">${affected.map((m) => escapeHtml(m.text)).join('; ')}</td></tr>`
        );
      }
    }
    parts.push('</tbody></table>');
  }

  container.innerHTML = parts.join('');
}

function renderStatus(state) {
  const container = document.getElementById('status-banner');
  if (!container) return;
  const messages = Object.entries(state.errors)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`);
  container.hidden = messages.length === 0;
  container.textContent = messages.join(' | ');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}
