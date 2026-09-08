# Boreal Live Bus Tracker — Implementation Plan (v2, post rubber-duck review)

## Problem
Build a web page that shows Kiruna bus routes and live traffic: routes on a
map, live vehicle positions, and per-stop scheduled + forecasted arrivals,
with filters for which lines/routes and vehicles are shown. Runs on
localhost first (hosting decided later). No backend proxy — the browser
calls the AnyRide API directly (CORS is currently allowed per README).

## Decisions (confirmed with user)
- Stack: plain HTML/CSS/JS (ES modules), no framework. Served as static
  files for a localhost dev server (e.g. `npx serve` or `python -m http.server`).
- Map: Leaflet, using the tile config returned by `GetConfigOptions`.
- Scope: map (routes + live vehicles) + arrivals list, both filterable.
- Route/stop scope: town-wide by default — all lines shown on the map with
  no stop pre-selected; user picks a stop (search/autocomplete or map click)
  to see its arrivals list.
- Live refresh: poll every 15 seconds.
- All application code lives under a `/src` sub-folder in the repo (not at
  the repo root, which holds `README.md`/`openapi.yaml`).

## Revisions after rubber-duck review
A rubber-duck pass on v1 found blocking design flaws. This version changes
the plan as follows (details in each section below):
- Route geometry discovery is now **opportunistic/lazy**, keyed by
  `(lineId, directionId)`, and stores **every observed routeId/geometry
  variant** instead of one "representative" route per line.
- Dropped the unsupported idea of filtering the *town-wide* vehicle layer
  by line (the API schema has no line/route id on `VehiclePosition`). Line-
  scoped vehicles are only shown for the **selected stop's** current calls,
  via `callId` → `GetVehiclePosition`.
- Polling is now stop-driven (no calls polling with nothing selected),
  uses request generation tokens + `AbortController` to avoid races, and
  filter changes only re-render cached state (no refetch).
- Added explicit handling for cancelled stops, traffic messages, timezone-
  safe time math, autocomplete debounce, and error/empty states.

## Architecture
Static site, no build step. All code under a `/src` sub-folder:
```
/src
  index.html
  /css/app.css
  /js
    api.js       -- fetch wrapper: profile headers, timeout/AbortController,
                     non-2xx -> typed errors with endpoint/status context
    config.js     -- GetConfigOptions once at startup; fails visibly if it
                     can't load; exposes profile headers, tiles, center/zoom
    lines.js       -- GetLines (session-cached, manual refresh option),
                     line filter state source
    routes.js       -- lazy per-(lineId,directionId) route discovery + a
                     cache of ALL observed routeId->MapRoute geometries
                     (see "Route geometry" below)
    map.js          -- Leaflet init, draws polylines for discovered route
                     variants, plots town-wide vehicle markers, click-to-
                     select stop
    stops.js         -- debounced Autocomplete, FindStopArea, FindStopsNear
                     Location; defensive null/empty handling
    calls.js          -- GetCalls polling for the selected stop only; flattens
                     CallGroup.calls; handles isStopCancelled, empty results,
                     TrafficMessage/affectedCalls joins
    stop-vehicles.js  -- for the selected stop's current TransitCalls, calls
                     GetVehiclePosition(callId) to show vehicles actually
                     tied to a line/journey (the only reliable line
                     correlation the API supports)
    filters.js        -- line filter state; applied client-side to map
                     polylines + arrivals list on every render, never
                     triggers a refetch by itself
    poller.js          -- generation-tokened interval loop: vehicles poll
                     always (15s); calls + stop-vehicles poll only while a
                     stop is selected (15s); pauses on hidden tab, does a
                     single controlled refresh on visibility resume;
                     discards responses from a stale generation
    state.js            -- small pub/sub store (selected stop, filters,
                     caches, request generation counter)
    main.js              -- wires modules together on DOMContentLoaded
```

## Data flow / API usage
1. On load: `GetConfigOptions` → profile headers, map center/zoom, tile
   template, time formatting rules. If this fails, show a visible error
   state and stop (nothing else works without profile headers).
2. `GetLines` → line filter checkboxes. Cached for the session; a manual
   "refresh lines" affordance covers rare mid-session changes.
3. Route geometry (lazy, per line+direction, multi-variant):
   - Do **not** bulk-probe all lines/directions at startup (avoids bursty
     load and depends on calls existing at that moment).
   - Discover `routeId`s incidentally from every `GetCalls` response
     already being fetched (selected-stop polling). Cache `MapRoute` by
     `routeId`, and keep a `Map<(lineId,directionId), Set<routeId>>`.
   - When a user enables a line filter whose `(lineId, directionId)` has no
     discovered route yet, opportunistically probe: `GetDirections` →
     `GetStopAreas(lineId, directionId)` → try a small number of stops →
     `GetCalls` filtered by `lineId` → read any `routeId`s off flattened
     `TransitCall`s → `GetMapRoute` each. Treat failure (no live calls
     right now) as "geometry unavailable for now", not an error; retry
     later or when more calls are observed.
   - Draw **all** discovered variants for a line (short-turns, branches,
     direction-specific shapes), not a single "representative" polyline.
4. Live vehicles (town-wide layer): `GetVehiclePositions` polled every 15s
   regardless of stop selection, always rendered **unfiltered by line**
   (schema has no line/route id on `VehiclePosition`; `classes`/`id` are
   not documented as line identifiers, so no filter claim is made here).
5. Arrivals list: user searches a stop via debounced `Autocomplete` (min
   query length, cancel stale requests) → `FindStopArea` (handle `null` =
   not found), or `FindStopsNearLocation` from a map click/geolocation.
   Selected stop triggers `GetCalls` (grouped by Line/Destination1),
   polled every 15s:
   - Flatten `CallGroup.calls` into a single list keyed by `TransitCall.id`;
     an empty/missing group is a valid "no departures" state, not an error.
   - If `isStopCancelled` is true, prominently show a cancelled-stop banner
     instead of presenting arrivals as normal.
   - Join `messages[].affectedCalls` (call ids) against the flattened calls
     to annotate affected rows; show untargeted line-level messages
     separately.
   - Filter rows client-side by the active line filter (re-render only,
     no refetch on filter toggle).
6. Stop-scoped vehicle correlation: for the selected stop's current
   `TransitCall`s, call `GetVehiclePosition(callId)` to get vehicles
   actually tied to a line/journey — this is the only line-correlated
   vehicle view the API supports; it covers "vehicles relevant to this
   stop", not a global per-line vehicle filter (documented as a scope
   limitation, not a bug).
7. `GetSystemTimestamp` used once at load to compute client/server clock
   offset. Time math uses parsed `Date` instants from `forecastTime`/
   `plannedTime` (not string/display comparisons), formatted for display
   with `Intl.DateTimeFormat` pinned to `Europe/Stockholm` to avoid
   midnight/timezone bugs for non-Sweden-based visitors; delay is computed
   from parsed instants, never from formatted strings.

## Filtering behavior
- Line filter: checkbox list (from `GetLines`), toggles discovered route
  polylines on the map and filters arrivals list rows. Toggling **never**
  triggers a network request — it only changes which cached data renders,
  except it may trigger the lazy per-line route discovery probe described
  above if that line's geometry is still unknown.
- Town-wide vehicle layer has no line filter (documented limitation).
  Stop-scoped vehicles (step 6) are implicitly "filtered" by virtue of
  being tied to the selected stop's calls.

## Polling design
- Central `poller.js` loop with a monotonically increasing generation
  counter and `AbortController` per request family (vehicles / calls /
  stop-vehicles). Any response whose generation no longer matches current
  state is discarded.
- Vehicles: always polling every 15s.
- Calls + stop-vehicles: only polling while a stop is selected; stopped
  immediately on deselect; restarted (not stacked) on new selection.
- No overlapping ticks per family; a slow response is aborted/ignored if a
  newer tick already started.
- Pause all polling on `visibilitychange` (hidden), do one controlled
  refresh (not a burst) on resume.

## Error / edge-case handling
- API wrapper rejects non-2xx with endpoint + status context; UI keeps the
  last known good data on transient failures and shows a visible
  freshness/error indicator rather than clearing the view.
- Autocomplete: debounced, minimum query length, stale-response guarding.
- `FindStopArea` returning `null`: show "stop not found", don't crash.
- Empty `GetCalls.calls`: valid "no departures" state.
- `GetVehiclePosition` returning `null`: skip that marker silently.

## Milestones
0. Once approved, copy this plan into the repo workspace as
   `initial_plan.md` (repo root, alongside `README.md`/`openapi.yaml`) for
   contributor reference, and create the `/src` sub-folder for all app code.
1. Config/lines wiring + static server on localhost; visible failure if
   config load fails.
2. Leaflet map with correct tiles/center/zoom, line filter UI (no routes
   yet), town-wide vehicle markers (unfiltered), polling skeleton with
   generation tokens.
3. Stop search (debounced) + `GetCalls` arrivals list: flattening,
   cancelled-stop banner, traffic message joins, empty-state handling,
   Stockholm-timezone time math.
4. Lazy per-line/direction route discovery + multi-variant polyline
   rendering, wired to line filter toggle-triggered probing.
5. Stop-scoped vehicle correlation via callId → `GetVehiclePosition`.
6. Error/edge-case hardening pass (network failures, empty/null states,
   visibility-based poll pause/resume), general polish.

## Notes
- Hosting/deployment target deferred; localhost-only for now.
- Refresh interval: 15 seconds for vehicles; calls/stop-vehicles poll at
  15s only while a stop is selected.
- All application code must be placed under a `/src` sub-folder in the repo.

## Post-implementation revisions (live user feedback)
- Map opens centered on Kiruna, Sweden by hardcoded coordinates;
  `GetConfigOptions.centerLat/centerLon` were observed returning a generic
  Boreal default (Kongsberg, Norway), not Kiruna, so config values are not
  trusted for map center.
- Route polylines and line badges are colored by parsing the Swedish color
  name out of each `Line.text` (Grön=green, Gul=yellow, Lila=purple,
  Röd=red) via `lineColors.js`, not by `TransitCall.lineAppearance`/
  `MapRoute.lineAppearance` - the API's own appearance color was observed
  unreliable (e.g. black for the red line).
- All 4 Kiruna lines' routes are now discovered proactively at startup
  (`main.js` calls `ensureLineRouteDiscovered` for every line once lines
  load), not only reactively when a user toggles a filter, so routes are
  visible without any user interaction.
- Added a `callInfo` index (`appState.js`, populated in `routes.js`)
  mapping every observed `TransitCall.id` -> `{lineId, destination,
  journey}`, accumulated from any `GetCalls` response seen (selected-stop
  polling and the startup discovery probes). This is the only way to
  attribute a town-wide `VehiclePosition` (which carries no line/route id)
  to a line/destination, by matching vehicle `id` against this index.
- Added a "Live buses" table (`ui.js` `renderVehiclesTable`, `#live-buses`
  in `index.html`) that is always populated from `state.vehicles` on page
  load and every poll tick - independent of any stop selection - showing
  line, destination (when correlatable via `callInfo`), vehicle id,
  lat/lon, and last-updated time. Map markers use the same `callInfo`
  correlation for marker color/tooltip label. This replaces the earlier
  design where bus/arrival data was only visible after selecting a stop.

## Post-implementation revisions round 2 (comprehensive live vehicle tracking)
Live testing found: the town-wide `GetVehiclePositions` endpoint
consistently returned `[]` even while buses were actively running, but
calling `GetVehiclePosition(callId)` individually for calls discovered
town-wide returned a live position for 201 of 202 currently active calls
across all 45 unique stops / 4 lines. So `GetVehiclePosition` per call id is
now the primary live-position source, replacing reliance on
`GetVehiclePositions`.

- `pool.js` (new): a small bounded-concurrency task runner
  (`runPooled(items, limit, worker)`), needed because a full town-wide scan
  touches 40+ stops or 200+ call ids - unbounded `Promise.all` would burst
  too many simultaneous requests.
- `call-discovery.js` (new): `refreshCallDiscovery()` finds every stop
  served by any line (`GetStopAreas` per line, deduped by `StopArea.id`),
  then calls `GetCalls(stop.text, lineId=0)` once per unique stop (one
  request covers all lines at that stop) to gather every currently active
  `TransitCall` town-wide. Feeds `recordRouteIdsFromCalls` (routes.js) as
  before. Runs once at startup and every 5 minutes thereafter (stops/lines
  rarely change; re-running discovery this often is just to catch newly
  scheduled journeys) - overlapping runs are guarded against.
- `live-vehicles.js` (new): `fetchAllLiveVehicles()` takes every call id
  known in `callInfo` (populated by the discovery scan above) and calls
  `GetVehiclePosition(callId)` for each (pooled, concurrency 15). Because
  `VehiclePosition.id` was verified to merely echo back the requested
  `callId` (not a stable per-vehicle identifier), results are deduped onto
  one physical bus by rounding `(lat, lon, timestamp)` into a key - two
  call ids reporting the same location at the same instant are the same
  vehicle. Runs every 15s via `poller.js`, skipping (not stacking) a tick
  if the previous scan is still in flight.
- `appState.js`: replaced `stopVehicles` (removed, along with
  `stop-vehicles.js`) with `liveVehicles: [{ key, position, lineId,
  destination, callIds }]` - one entry per distinct physical bus, this is
  now the single source `map.js` and `ui.js`'s "Live buses" table both
  render from, so every live bus appears simultaneously on its route and
  in the table without requiring a stop to be selected.
- Known tradeoff (documented, not hidden): scanning 150-200+ call ids every
  15s is a real request-volume/rate-limit risk against an undocumented,
  unauthenticated API. Mitigated by pooling (bounded concurrency) and by
  skipping overlapping ticks, but not eliminated - flagged for future
  revisiting if the API starts throttling or the line count grows.

## Post-implementation revisions round 3 (stale position detection)
User observed some map markers/table rows appearing to be live buses but
not actually moving. Checked the schema (`openapi.yaml`): neither
`VehiclePosition` nor `TransitCall` has any "in service" / active flag -
`GetVehiclePosition(callId)` just echoes back that call's last known GPS
fix even if the vehicle hasn't reported in a long time (trip finished,
vehicle offline, or a scheduled-only journey with no real vehicle assigned
yet). So "in service" is not something the API tells us directly; it has
to be inferred from how old `VehiclePosition.timestamp` is.

- `live-vehicles.js`: each deduped vehicle now also carries `ageMs` (time
  since `position.timestamp`, using the server-clock-corrected `now()` from
  `clock.js` so a visitor's own clock skew doesn't matter) and `stale`
  (`ageMs > STALE_THRESHOLD_MS`, currently 3 minutes - well beyond one 15s
  poll cycle, so a single slow update doesn't false-positive).
- Per the plan's existing error-handling philosophy (show a freshness
  indicator, never silently hide/drop data), stale vehicles are still
  shown, not removed:
  - `map.js`: stale markers get a faded fill, dashed outline, and a tooltip
    noting "(stale, N min ago)".
  - `ui.js`: the Live buses table gets a Status column ("Live" / "Stale (N
    min ago)"), a dimmed row style for stale entries, and a summary hint
    line when any are stale, explaining that this is inferred, not an
    explicit API field.

  ## Post-implementation revisions round 4 (per-journey fetch reduction + next-stop info)
  User noticed a surprisingly high number of `GetVehiclePosition` requests
  for a town with only a handful of real buses. Live probing confirmed why:
  **a `TransitCall.id` changes at every remaining stop along a journey's
  route** - one observed journey alone had 37 distinct call ids (one per
  upcoming stop), while the whole town had 176 active call ids for only
  **12 unique `journeyId`s** running at that moment. So the previous
  "one `GetVehiclePosition` per call id" design was making ~15x more
  requests than there are real vehicles.

  - `call-discovery.js`: rewrote to tag every call with the stop name it was
    fetched from (`stopText`), accumulate all town-wide calls across the
    pooled per-stop scan, then build a new `journeyVehicles` map in one pass
    at the end of each discovery cycle: for each `journeyId`, keep only the
    call id(s) at that journey's **lowest `sequenceNumber`** (its next
    upcoming stop). A journey can have 2 physical vehicles (main +
    reinforcement/"extra" bus - confirmed live: two distinct call ids
    reporting different positions at the same `sequenceNumber`), so both
    are kept when present. Rebuilt from scratch every discovery pass (not
    merged) so finished journeys don't linger.
  - `appState.js`: replaced `callInfo` (per-call-id index) with
    `journeyVehicles` (per-journey index, `journeyId -> {sequenceNumber,
    lineId, destination, journey, stopText, arrival, departure, callIds}`).
  - `live-vehicles.js`: now fetches `GetVehiclePosition` only for the call
    ids in `journeyVehicles` (roughly one or two requests per running
    journey - dropped from 176 to about 20-24 requests per poll in live
    testing), instead of every call id town-wide. Each resulting vehicle
    also now carries `nextStop: { stopText, plannedTime, forecastTime }`,
    taken from that representative call's `arrival` Forecast (falling back
    to `departure` for a call at the very start of a journey).
  - `ui.js`: Live buses table gained **Next stop**, **Planned**, and
    **Expected** columns (from `nextStop`), so each row shows not just
    where a bus currently is, but where it's headed next and whether it's
    running on time.
  - `map.js`: vehicle marker tooltips now also include the next stop name.

## Post-implementation revisions round 5 (arrows, selection, table columns)

User feedback: buses should show a **directional arrow** instead of a plain
dot; clicking a table row should **highlight that bus** on the map; the
**Position (lat/lon) column** was clutter; the Line column should show the
short line name rather than the long route description; and **occupancy**
should be visible.

- **Selection identity - `journeyId`, not `key`.** The obvious choice,
  `liveVehicles[].key`, is derived from `(lat, lon, timestamp)` and
  therefore **changes on every poll tick as the bus moves** - a selection
  tracked by `key` would silently drop the moment the bus reported a new
  position. `journeyId` is carried through unchanged from
  `TransitCall.journeyId` and is stable for the life of the journey, so
  `appState.js` gained `selectedVehicleJourneyId` keyed on that.
- `vehicleSelection.js` (new): `selectVehicle(journeyId)` (click the
  selected row again to toggle off) and `clearVehicleSelection()`. Pure
  client-side state, no refetch - same principle as `filters.js`.
- `map.js`: `L.circleMarker` replaced with `L.marker` + `L.divIcon`
  containing a CSS triangle rotated by `VehiclePosition.heading`. The
  rotation is an **inline** `transform` on the inner element, so the
  selected-state `transform: scale(...)` had to move to an outer wrapper
  element (`.vehicle-icon-wrapper--selected`) - an inline style always
  beats a stylesheet rule on the same element regardless of specificity,
  so both could not live on one node.
- Pan/tooltip on select fires **once**, guarded by a module-level
  `lastSelectedJourneyId`; otherwise every 15s re-render would yank the map
  back and reopen the tooltip while a bus stayed selected.
- `call-discovery.js` / `live-vehicles.js`: thread `line`
  (`TransitCall.line`, the short name e.g. `"Röd."`) and
  `Forecast.occupancyPercent` through `journeyVehicles` -> `liveVehicles`.
  Both fields were already present in the `GetCalls` responses being
  fetched, so **no new API calls** were introduced.
- `ui.js`: dropped the Position column, switched Line to the short name
  (trailing period trimmed), added an **Occupancy** column (`"42%"` or
  `"—"` when the operator reports nothing), added `data-journey-id` on each
  row plus one delegated click listener (the table's `innerHTML` is rebuilt
  every tick, so per-row listeners would leak), and a `row-selected` class.

## Post-implementation revisions round 6 (freshness + startup latency)

Three issues surfaced while using the round 5 build:

- **Table data never updated.** `refreshCallDiscovery()` ran on a 5-minute
  timer because it re-derived the whole stop list (`GetStopAreas` per line)
  on every pass. But `journeyVehicles` - the source of Next stop / Planned /
  Expected / Occupancy - was rebuilt only inside that same pass, so those
  columns were effectively frozen for up to 5 minutes while marker
  positions kept moving. Fix: split the two concerns. The stop list is now
  cached behind a separate `refreshStopsList()` on the slow 5-minute timer
  (stops served per line essentially never change mid-session), while
  `refreshCallDiscovery()` reuses that cache and re-scans `GetCalls` on the
  **15s** tick.
- **Position and schedule data could disagree.** `pollLiveVehicles()` now
  awaits `refreshCallDiscovery()` and *then* `fetchAllLiveVehicles()` in
  the same tick, so a bus's plotted position and its "next stop" always
  come from the same scan rather than from two independently-timed loops.
  The existing skip-if-still-running guard covers the longer combined tick.
- **Nothing on screen for the first ~15s.** Both loops already fired
  immediately on start; the real delay was the serialised discovery timer.
  With the split above, the first tick issues one `GetCalls` per stop and
  renders as soon as it returns.
- `map.js`: the selected bus's tooltip now auto-closes after 3 seconds via
  `setTimeout(() => marker.closeTooltip(), 3000)`, while the marker
  highlight persists until the row is clicked again - the tooltip was
  previously staying open indefinitely and covering the map.

## Post-implementation revisions round 7 (next stop by forecast time, stop circles)

The Live buses table's "Next stop" was wrong: two Yellow buses at clearly
different map positions showed the *same* next stop.

- **Root cause was in the position dedupe, not the grouping.** Calls were
  already grouped by `journeyId`, so the bug was one layer further down.
  `GetVehiclePosition` returns the *same* GPS fix for every journey
  currently assigned to a physical bus - including that bus's **later
  trips of the day**. `live-vehicles.js` deduped those onto one vehicle by
  `(lat, lon, timestamp)` and kept whichever result arrived **first**,
  which is nondeterministic (pooled request completion order). So a bus
  could be labelled with a future journey's next stop, and two different
  buses could inherit labels that made them look identical. Verified live:
  4 Yellow journeys collapsed onto just 2 physical GPS fixes.
- **Fix**: when several journeys share one physical position, keep the one
  whose next forecast is **soonest in the future** (past-dated forecasts
  rank last, missing ones last of all), merging the call ids. After the
  fix the two Yellow buses correctly resolved to *Signalen* and
  *Porfyren*.
- **Next stop is now chosen by earliest future forecast time**, not lowest
  `sequenceNumber`. `buildJourneyVehicles` keeps every call for a journey,
  filters to those whose `arrival ?? departure` `forecastTime` is still in
  the future (server-clock adjusted via `clock.js`'s `now()`), and picks
  the soonest; `sequenceNumber` survives only as a tie-breaker and as a
  fallback when a journey has no future-dated call left (sitting at its
  terminus). Verified live that both methods currently agree for all 15
  running journeys - the API does prune passed calls - but time-based
  selection *structurally cannot* surface a stop the bus has already left,
  which lowest-`sequenceNumber` would as soon as any stop's `GetCalls`
  response were stale or cached.
- **Stop circles on the map.** `GetStopAreas` returns every stop with
  `location` unset (confirmed live: 0 of 45 Kiruna stops had coordinates),
  but `FindStopArea` *does* populate it for the same stop text. So
  `call-discovery.js` resolves each unique stop once via `FindStopArea`
  into a new `stopLocations` store map (stops don't move, so it's never
  invalidated), and `map.js` draws a small `circleMarker` per stop on its
  own layer between the routes and the vehicles. Clicking a circle selects
  that stop directly - necessary because the circle would otherwise
  swallow the map-level click that resolves a stop via
  `FindStopsNearLocation`.
- Buses whose last position fix is older than **15 minutes** are now
  omitted from the Live buses table entirely (the existing "stale" styling
  still covers the 3-15 minute window); map behaviour is unchanged.
