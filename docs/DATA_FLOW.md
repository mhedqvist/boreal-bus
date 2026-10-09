# Data Flow — Current Implementation

Describes how data actually moves through the app, end to end: the server in
`/server` (which talks to Boreal), and the browser code in `/src` (which only
talks to the server). See `API.md` for the underlying endpoint contracts, and
`initial_plan.md` for the design rationale/history (written when scanning ran
in the browser; that logic now lives in `server/lib/tracker.js`).

## 0. The server (`/server`)

```
Browser ──► /api/buses, /api/stops, /api/<BorealEndpoint> ──► server ──► Boreal
```

- `/api/buses` — every running bus (position, line, destination, next two
  stops with planned/forecast times, age/stale flag) plus `lineRoutes`
  (`{ lineId: routeId[] }`). Built by `tracker.js`:
  - **Stop scan** every ~3 min (or earlier after a failed position fetch,
    at most every 30 s): `GetCalls` for every stop, grouped by `journeyId`
    into ordered stop lists. A journey's `positionCallIds` are the call ids
    of its last stop.
  - **Positions** at most every 15 s: `GetVehiclePosition` per journey,
    deduped by `(lat, lon, timestamp)` onto the journey with the soonest
    future forecast. `nextStop`/`followingStop`/`ageMs` are computed per
    request using the Boreal-corrected clock.
  - Refresh is lazy (only when a request finds data expired), concurrent
    requests share one refresh, and failures keep serving the last data with
    `error` set.
- `/api/stops` — `[{ id, text, location }]`, coordinates resolved once.
- `/api/<BorealEndpoint>` — allow-listed passthrough with short TTL caches
  (`passthrough.js`) that injects the Kiruna profile headers, so the
  browser code can call the unchanged endpoints (`GetLines`, `GetCalls`,
  `GetMapRoute`, `FindStopArea`, ...).
- Everything else is static files from `src/`.

## 1. Startup sequence (`main.js`)

```
main()
 ├─ 1. loadConfig()                     [config.js]   ── must succeed first
 │     GetConfigOptions → store profile headers, tile URL, minZoom
 │     (fails → visible fatal error, nothing else runs)
 │
 ├─ 2. loadLines() + initClockOffset()  [lines.js, clock.js]  ── parallel
 │     GetLines            → store.lines
 │     GetSystemTimestamp  → store.clockOffsetMs (server - client time)
 │
 ├─ 3. initMap('map')                   [map.js]
 │     creates Leaflet map centered on hardcoded Kiruna coords,
 │     subscribes to the store, does an initial render() from empty state
 │
 ├─ 4. initUi()                         [ui.js]
 │     wires the stop-search box, subscribes to the store, does an
 │     initial render of (empty) filters/table/arrivals/status
 │
 └─ 5. initPoller()                     [poller.js]
       starts the live-bus polling schedule (see §3)
```

All of `map.js`/`ui.js` render purely as a **function of the shared
store** (`appState.js`) — nothing renders by being called directly by the
things that fetch data. Every fetch just calls `store.set(...)`, which
notifies subscribers, which re-render. This is the one data-flow rule that
holds throughout the app.

## 2. The shared store (`appState.js` + `state.js`)

A minimal pub/sub object (`state.js`'s `createStore`) holds the single
source of truth. Every other module either **writes** to it (fetch/derive
modules) or **reads + subscribes** to it (`map.js`, `ui.js`). No module
talks to another rendering module directly.

Key fields and who writes them:

| Field | Written by | Read by |
|---|---|---|
| `lines`, `activeLineIds` | `lines.js`, `filters.js` | `map.js`, `ui.js` |
| `selectedStop`, `calls`, `isStopCancelled`, `messages` | `stops.js`, `calls.js` | `ui.js` |
| `liveVehicles` | `live-vehicles.js` (from `/api/buses`) | `map.js`, `ui.js` |
| `lineRoutes`, `routeGeometry` | `routes.js` (`mergeLineRoutes`, `recordRouteIdsFromCalls`, `fetchGeometries`) | `map.js` (route polylines) |
| `stopLocations` | `stop-locations.js` (from `/api/stops`) | `map.js` (stop circles) |
| `selectedVehicleJourneyId` | `vehicleSelection.js` (row click) | `map.js` (marker highlight/pan), `ui.js` (row highlight) |
| `clockOffsetMs` | `clock.js` | `ui.js` (countdowns) |
| `errors.*` | every fetch module, on failure | `ui.js` (`renderStatus`) |

## 3. Continuous polling loops (`poller.js`)

Two schedules run from `poller.js`, both using `AbortController`; a shared
`generation` counter is bumped on stop select/deselect and pause/resume so
responses tied to stale UI state are discarded.

1. **`pollLiveVehicles`** (60s) — one request per tick:
   ```
   refreshLiveVehicles()                     [live-vehicles.js]
     GET /api/buses
     → store.set({ liveVehicles, errors.vehicles = data.error })
     → mergeLineRoutes(data.lineRoutes)      [routes.js]
          add to lineRoutes; GetMapRoute for each new routeId
          → store.routeGeometry
   refreshStopLocations()                    [stop-locations.js]
     GET /api/stops (only until loaded)  → store.stopLocations
   ```
   Self-guards against overlapping ticks (`liveVehiclesRunning`) since the
   very first request can take several seconds while the server warms up.
   The browser never talks to Boreal's scan endpoints; the server's caches
   decide when Boreal is actually contacted (§0).

2. **`pollCalls`** (60s, only while a stop is selected) —
   `fetchCallsForSelectedStop` [`calls.js`] calls `GetCalls` (via the
   server's cached passthrough) for `store.selectedStop`, flattens
   `CallGroup.calls`, updates `store.calls`/`isStopCancelled`/`messages`,
   and feeds the same calls into `recordRouteIdsFromCalls`.

Both loops pause on `document.visibilitychange` (tab hidden) and, on
resume, bump `generation` (discarding stale in-flight responses) before
restarting.

## 4. Map rendering (`map.js`)

Subscribed to the store; re-renders on every `store.set(...)` anywhere:

- **Routes**: for each active line id in `activeLineIds`, for each
  `routeId` in `lineRoutes.get(lineId)`, draws a polyline from
  `routeGeometry.get(routeId).locations`, colored via
  `colorForLineId(lineId)` (parses the Swedish color word out of the
  line's `text`, see `lineColors.js` — not `lineAppearance`, which was
  observed unreliable).
- **Vehicles**: iterates `state.liveVehicles`, skips any whose `lineId`
  isn't in `activeLineIds`, and draws an `L.marker` with an `L.divIcon` at
  `position.location`. The arrow uses `position.heading` when reported;
  otherwise its direction is derived from the nearest segment of
  `routeGeometry[bus.routeId]`, oriented toward `bus.nextStop` (or a dot is
  used until both route and stop geometry are available). Markers are
  colored by `colorForLineId(bus.lineId)` (gray if
  uncorrelated), faded if `bus.stale`, with a tooltip showing line →
  destination → next stop (and staleness age if stale). When
  `bus.journeyId === state.selectedVehicleJourneyId` the marker gets a
  scaled/glowing wrapper class; on the render immediately following a
  selection change (tracked via a module-level `lastSelectedJourneyId`)
  the map pans to it once and opens its tooltip for 3 seconds.
- **Stops**: a small `circleMarker` for every entry in
  `state.stopLocations`, on its own layer between the routes and the
  vehicles, with the stop name as a tooltip. The currently selected stop
  is drawn larger and in blue. Clicking a circle calls `selectStopArea`
  directly (with `bubblingMouseEvents: false`) — the circle would
  otherwise swallow the map-level click that resolves a stop via
  `FindStopsNearLocation`.
- **Stop selection**: a map click calls `FindStopsNearLocation`
  [`stops.js`], and on a hit, marks the clicked stop and calls
  `selectStopArea`, which updates `store.selectedStop` (triggering
  `poller.js`'s `onStopSelected`, starting the calls-polling loop).

## 5. UI rendering (`ui.js`)

Also subscribed to the store; on every change re-renders four
independent pieces:

- **Line filters**: checkbox list from `state.lines`; checked state from
  `activeLineIds`. Toggling calls `filters.js`'s `toggleLine`, which
  **only** flips `activeLineIds` (no network call) — except turning a
  line *on* also calls `ensureLineRouteDiscovered(lineId)` as a
  just-in-case fallback probe if that line's route geometry is still
  completely unknown (normally already populated via `/api/buses`).
- **Live buses table**: same `state.liveVehicles` data as the map
  markers, filtered by `activeLineIds` and to buses whose last position
  fix is under 15 minutes old, one row per physical bus (line badge with
  the short line name, destination, next stop with its planned and
  expected times, the following stop and its expected time ("Then"),
  last-updated time, and Live/Stale status). Each row carries a `data-journey-id`; a single delegated click
  listener (bound once, since the table's `innerHTML` is rebuilt every
  tick) calls `selectVehicle(journeyId)` [`vehicleSelection.js`], which
  toggles `state.selectedVehicleJourneyId` — pure client-side state, no
  refetch — highlighting both the row and its map marker.
- **Arrivals list**: from `state.calls` (the selected stop's flattened
  departures), filtered by `activeLineIds`, joined against
  `state.messages` for disruption banners, with a cancelled-stop banner
  when `isStopCancelled`.
- **Status banner**: surfaces `state.errors.*` (config/lines/vehicles/
  calls/stopNotFound) without clearing previously-good data underneath.

## 6. Stop search flow (`stops.js`)

```
user types → debounced Autocomplete(query)        [stops.js]
           → user picks a result
           → FindStopArea(StopAreaQuery) or
             FindStopsNearLocation (map click)
           → selectStopArea(stop)
                store.set({ selectedStop: stop })
                poller.onStopSelected() → generation += 1, starts pollCalls
```

Deselecting a stop (`clearSelectedStop`) does the reverse: bumps
`generation`, stops the calls-polling loop, and clears
`calls`/`isStopCancelled`/`messages` from the store.

## 7. End-to-end picture

```
Boreal AnyRide API
        │ HTTP (server-side only; cached, rate-limited by TTLs)
        ▼
server (tracker.js, passthrough.js)  ── also serves src/
        │ /api/buses, /api/stops, /api/<endpoint>
        ▼
api.js (timeout, cancellation, typed errors)
        │
        ▼
poller.js + fetch/derive modules
  ├─ pollLiveVehicles (60s) → /api/buses (+ /api/stops until loaded)
  └─ pollCalls (60s while a stop is selected)
        │ store.set(...)
        ▼
appState.js shared store
        │ subscriber notification
        ▼
map.js + ui.js (render state; no direct API fetches)
```

Everything downstream of `api.js` ends up as a `store.set(...)` call;
everything upstream of the store (`map.js`, `ui.js`) only ever reads state
and never fetches — this one-directional flow (fetch → store → render) is
what keeps polling, filtering, and stop-selection from stepping on each
other.
