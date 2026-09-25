# Data Flow — Current Implementation

Describes how data actually moves through the app in `/src`, end to end:
what runs at startup, what polls continuously, and how a user action (line
filter toggle, stop search) changes what's rendered. See `API.md` for the
underlying endpoint contracts, and `initial_plan.md` for the design
rationale/history behind each decision below.

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
 │     initial render of (empty) filters/cards/status
 │
 ├─ 5. initCommuter()                   [commuter.js]
 │     restores favorite stops and wires on-demand nearby-stop lookup
 │
 └─ 6. initPoller()                     [poller.js]
       immediately starts three polling schedules (see §3)
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
| `selectedStop`, `calls`, `isCallsLoading`, `isStopCancelled`, `messages` | `stops.js`, `calls.js`, `poller.js` | `ui.js` |
| `liveVehicles` | `live-vehicles.js` | `map.js`, `ui.js` (primary live-bus source) |
| `lineRoutes`, `routeGeometry` | `routes.js` (`recordRouteIdsFromCalls`, `fetchGeometries`) | `map.js` (route polylines) |
| `journeyVehicles` | `call-discovery.js` (`buildJourneyData`) | `live-vehicles.js` (which call ids to fetch positions for, plus line/destination/next-stop labels) |
| `journeyStops` | `call-discovery.js` (`buildJourneyData`) | `ui.js` (selected bus trip), `map.js` (upcoming-stop emphasis) |
| `stopLocations` | `call-discovery.js` (`resolveStopLocations`, via `FindStopArea`) | `map.js` (stop circles) |
| `selectedVehicleJourneyId` | `vehicleSelection.js` (bus card/marker click) | `map.js` (marker highlight/pan), `ui.js` (card expansion) |
| `clockOffsetMs` | `clock.js` | `call-discovery.js` (future-stop selection), `live-vehicles.js` (staleness), `ui.js` (countdowns) |
| `errors.*` | every fetch module, on failure | `ui.js` (`renderStatus`) |

## 3. Continuous polling loops (`poller.js`)

Three schedules run from `poller.js`. The live-vehicle and selected-stop request
families use `AbortController`; a shared `generation` counter is bumped on
stop select/deselect and pause/resume so responses tied to stale UI state
are discarded. `pollLiveVehicles` deliberately sequences call discovery
before position fetching rather than running them independently:

1. **`pollLiveVehicles`** (15s) — the real live-position feed. Runs the
   town-wide call scan and the position fetch back-to-back in one tick, so
   a bus's plotted position and its scheduled/forecast "next stop" data
   always come from the same scan:
   ```
   refreshCallDiscovery()                    [call-discovery.js]  (see 4)
     → store.set({ journeyVehicles, journeyStops })
   then
   fetchAllLiveVehicles()                    [live-vehicles.js]
     reads store.journeyVehicles (one entry per running journey)
     → runPooled(representative callIds, concurrency=15, GetVehiclePosition)
     → dedupe results into physical vehicles by (lat, lon, timestamp) key,
       keeping the journey whose next forecast is soonest in the future
       (one bus's later trips of the day report the same GPS fix)
     → tag each with ageMs/stale using clock.js's server-corrected now()
     → attach line, journeyId, routeId, and nextStop {stopText, plannedTime,
       forecastTime} from the representative call
     → store.set({ liveVehicles })
   ```
   Self-guards against overlapping ticks (`liveVehiclesRunning`) since the
   combined scan can take a few seconds. Failures use capped exponential
   backoff; rate-limit responses leave previously good data visible.

2. **`pollCalls`** (15s, only while a stop is selected) —
   `fetchCallsForSelectedStop` [`calls.js`] calls `GetCalls` for
   `store.selectedStop`, flattens `CallGroup.calls`, updates
   `store.calls`/`isStopCancelled`/`messages`, and feeds the same calls
   into `recordRouteIdsFromCalls` (so route geometry can also be
   discovered incidentally from stop-specific polling, not just the
   town-wide scan).

   Route geometry is cached in `store.routeGeometry` for the page session.
   `routes.js` shares an in-flight request when concurrent scans discover
   the same route. `map.js` keeps each Leaflet polyline and its route
   coordinates until that route's geometry changes; filtering only hides
   or shows it, and selecting a bus changes its style in place. Shared
   segments of differently colored active routes use alternating dashes;
   unshared segments remain solid. Panning and normal live updates do not
   rebuild the route layers.

3. **`refreshStopsList`** (every 5 minutes) — the expensive half of
   discovery, split out so it doesn't gate the 15s data refresh. The set of
   stops served by each line essentially never changes mid-session:
   ```
   refreshStopsList()                        [call-discovery.js]
     GetStopAreas(lineId, null) for every line, pooled  → dedupe by stop.id
     → cachedStops (module-level, not in the store)
     → FindStopArea per not-yet-resolved stop, pooled
          (GetStopAreas omits `location`; FindStopArea returns it)
       → store.stopLocations  (stopAreaId -> {text, location})
   ```

   **`refreshCallDiscovery`** (every 15s, driven by `pollLiveVehicles`
   above) — reuses `cachedStops` and re-scans calls town-wide:
   ```
   refreshCallDiscovery()                    [call-discovery.js]
     GetCalls(stop.text, lineId=0) for every cached stop, pooled
     → flatten CallGroup.calls, tagging each with its stop's text
     → recordRouteIdsFromCalls(flat)          [routes.js]
          lineRoutes.get(call.lineId).add(call.routeId)
          if routeGeometry missing for routeId → queue GetMapRoute fetch
     → fetchGeometries(routeIds)              [routes.js]
          GetMapRoute per new routeId → store.routeGeometry
     → buildJourneyData(callsWithStop)
          group by journeyId, keep the call for the stop with the earliest
          forecastTime still in the future (arrival ?? departure, compared
          against clock.js's server-adjusted now(); sequenceNumber is only
          a tie-breaker, and the lowest one a fallback when nothing is
          future-dated), plus any sibling call id at that same stop for a
          reinforcement bus, capturing line/destination/stopText/
          arrival/departure; also retain ordered future stops for the trip view
     → store.set({ journeyVehicles, journeyStops }) (rebuilt from scratch, so
                                                     finished journeys drop out)
   ```
   Guarded against overlapping runs via an `inFlight` promise.

   A journey's `TransitCall.id` changes at *every* remaining stop on its
   route, so grouping by `journeyId` and keeping only the next-stop call is
   what keeps this to roughly one request per real bus (~20) instead of one
   per call id (~176) — see `API.md` quirk #8.

All three loops pause on `document.visibilitychange` (tab hidden) and, on
resume, bump `generation` (discarding stale in-flight responses) before
restarting.

## 4. Map rendering (`map.js`)

Subscribed to the store; updates only layers whose inputs change:

- **Routes**: for each active line id in `activeLineIds`, for each
  `routeId` in `lineRoutes.get(lineId)`, draws a polyline from
  `routeGeometry.get(routeId).locations`, colored via
  `colorForLineId(lineId)` (parses the Swedish color word out of the
  line's `text`, see `lineColors.js` — not `lineAppearance`, which was
  observed unreliable). The selected bus's route is emphasized.
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
  the map pans to it once and opens its tooltip for 3 seconds. Markers are
  reused and moved as new fixes arrive; clicking one selects its journey.
- **Stops**: a small `circleMarker` for every entry in
  `state.stopLocations`, on its own layer between the routes and the
  vehicles, with the stop name as a tooltip. The currently selected stop
  is drawn larger and in blue; the selected journey's upcoming stops are
  highlighted. Clicking a circle calls `selectStopArea`
  directly (with `bubblingMouseEvents: false`) — the circle would
  otherwise swallow the map-level click that resolves a stop via
  `FindStopsNearLocation`.
- **Stop selection**: a map click calls `FindStopsNearLocation`
  [`stops.js`], and on a hit, marks the clicked stop and calls
  `selectStopArea`, which updates `store.selectedStop` (triggering
  `poller.js`'s `onStopSelected`, starting the calls-polling loop). Selecting
  through search or shortcuts also pans the map to the chosen stop once.

## 5. UI rendering (`ui.js`)

Also subscribed to the store; re-renders only the pieces whose inputs change:

- **Line filters**: checkbox list inside the collapsed Lines disclosure;
  checked state from
  `activeLineIds`. Toggling calls `filters.js`'s `toggleLine`, which
  **only** flips `activeLineIds` (no network call) — except turning a
  line *on* also calls `ensureLineRouteDiscovered(lineId)` as a
  just-in-case fallback probe if that line's route geometry is still
  completely unknown (normally already populated by the town-wide
  discovery scan).
- **Live bus cards**: same `state.liveVehicles` data as the map
  markers, filtered by `activeLineIds` and to buses whose last position
  fix is under 15 minutes old (plus the selected bus), one card per physical
  bus. Each selectable button carries a `data-journey-id`; a delegated click
  listener (bound once, since the list's `innerHTML` is rebuilt every
  tick) calls `selectVehicle(journeyId)` [`vehicleSelection.js`], which
  toggles `state.selectedVehicleJourneyId` — pure client-side state, no
  refetch — previewing the next three stops from `state.journeyStops`
  (with a disclosure for the rest) and highlighting the map marker.
  A shared early/late difference is summarized once above the stops.
  Keyboard focus is preserved across position updates.
- **Departure cards**: from `state.calls` (the selected stop's flattened
  departures), filtered by `activeLineIds`, joined against
  `state.messages` for disruption banners, with a cancelled-stop banner
  when `isStopCancelled`. No card is shown before a stop is selected;
  `isCallsLoading` distinguishes an initial fetch from a true empty result.
- **Status banner**: surfaces `state.errors.*` (config/lines/vehicles/
  calls/stopNotFound) without clearing previously-good data underneath.

## 6. Stop search flow (`stops.js`)

```
user types → debounced Autocomplete(query)        [stops.js]
           → user picks a result
           → FindStopArea(StopAreaQuery) or
             FindStopsNearLocation (map click)
           → selectStopArea(stop)
                store.set({ selectedStop: stop, calls: [], isCallsLoading: true })
                poller.onStopSelected() → generation += 1, starts pollCalls
```

Deselecting a stop (`clearSelectedStop`) does the reverse: bumps
`generation`, stops the calls-polling loop, and clears
`calls`/`isCallsLoading`/`isStopCancelled`/`messages` from the store.

## 7. End-to-end picture

```
Boreal AnyRide API
        │ HTTP
        ▼
api.js (headers, timeout, cancellation, typed errors)
        │
        ▼
poller.js + fetch/derive modules
  ├─ pollLiveVehicles (15s with failure backoff)
  │    ├─ refreshCallDiscovery
  │    └─ fetchAllLiveVehicles
  ├─ pollCalls (15s while a stop is selected)
  └─ refreshStopsList (5 min)
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
