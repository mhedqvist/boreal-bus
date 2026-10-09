# Kiruna Live Bus Tracker

A browser-based live transit map for Kiruna, Sweden, built with plain
HTML/CSS/JavaScript and Leaflet, plus a small dependency-free Node server.
The Boreal AnyRide API sends no CORS headers, so browsers cannot call it
directly. The server fetches and caches the data once and serves both the
JSON API the page uses and the page itself. There is no build step or
database.

## Features

- All discovered bus routes, colored by their Swedish line names.
- Directional vehicle arrows using each reported heading, falling back to
  the nearest route segment oriented toward the next stop when heading is
  unavailable.
- Live buses table with short line name, destination, next stop, planned and
  expected arrival, update time, and freshness status.
- Click a table row to pan to and highlight that bus; its tooltip closes after
  three seconds while the highlight remains. Click the row again to clear it.
- All bus stops shown as clickable circles; selecting one displays its live
  arrivals. Stops can also be selected through autocomplete or a map click.
- Client-side line filters apply to routes, vehicle markers, and table rows.
- Automatic refresh every 60 seconds; polling pauses in a hidden browser tab
  and resumes immediately when the tab becomes visible.
- Positions older than three minutes are marked stale. Positions older than
  15 minutes remain visible on the map but are omitted from the table.
- Responsive phone, tablet, and desktop layouts: phones and tablet portrait
  use a map-first scrolling page, while tablet landscape and desktop use a
  two-column map/sidebar view. Wide data tables scroll within their panels.
- Touch-sized controls plus keyboard navigation for stop suggestions and live
  bus selection.

## Run locally

Requires Node 20 or newer. From the repository root:

```powershell
cd server
node index.js
```

Then open <http://localhost:8080/>. The server serves the frontend from
`src/` and the API under `/api`. An internet connection is required for
Leaflet/OpenStreetMap assets and the Boreal API. See
[server/README.md](server/README.md) for configuration, endpoints, tests and
deployment (including Docker).

## How live tracking works

The server (`server/lib/tracker.js`) does all the scanning. It contacts
Boreal only when a request arrives and its cached data has expired, so
upstream traffic does not grow with the number of visitors:

1. Every ~3 minutes it fetches calls for all known stops and groups them by
   `journeyId`, storing each journey's ordered stop list with
   planned/forecast times. A failed position fetch triggers an earlier rescan.
2. At most every 15 seconds it calls `GetVehiclePosition` for each journey's
   stored call id (any call id of a journey returns the same bus position).
3. It deduplicates identical `(latitude, longitude, timestamp)` fixes into
   physical buses. Because the API also maps later journeys to the same bus,
   the journey with the nearest future forecast supplies the displayed
   destination and the next two stops ("Next stop" and "Then") with their
   expected times.

The page polls `/api/buses` every 60 seconds and gets every bus ready to
display in one request. Stop coordinates are resolved once by the server
(`/api/stops`), because `GetStopAreas` returns Kiruna stops without
locations. If Boreal becomes unreachable the server keeps serving the last
known data, with the error reported in the response.

## Hosting the page separately

If the page is hosted elsewhere (for example GitHub Pages), set `apiBase` in
`src/runtime-config.js` to the server's API URL
(`https://your-server.example.com/api`) and set `ALLOWED_ORIGINS` on the
server to the page's origin.

## Project structure

```text
src/                  Static web application
  index.html
  css/app.css
  js/*.js             ES modules; no bundler
server/               Node server: cached Boreal API client, /api, static hosting
docs/API.md           Endpoint and schema reference plus observed quirks
docs/DATA_FLOW.md     Current runtime architecture and data flow
docs/initial_plan.md  Historical design plan and implementation revisions
openapi.yaml          Machine-readable API contract
```

See [API documentation](docs/API.md) and
[current data flow](docs/DATA_FLOW.md) for implementation details.

## API background

The API is used by the real-time information page at
<https://lokaltrafikenkiruna.se/realtidsinformation/>, which embeds the Boreal
AnyRide client at <https://boreal.tmix.se/anyride/>. The client calls:

```text
https://boreal.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api/
```

The machine-readable contract is available in [openapi.yaml](openapi.yaml).

## Support and stability

This is an internal API used by the public AnyRide web client. It does not
publish Swagger or other official API documentation. No authentication was
required when the API was inspected on 2026-09-07, but endpoints, headers, and
response formats may change without notice.

The upstream API does not send CORS headers, so browsers cannot read its
responses from another origin. This project's server fetches it server-side
(see [server/README.md](server/README.md)).

## Kiruna profile

Call `GetConfigOptions` first. Its response identifies the data and display
profiles used by subsequent requests:

```json
{
  "profileData": "boreal_kiruna",
  "profileDisplay": "boreal"
}
```

Send those values as headers on all data requests:

```http
anyride-profile-data: boreal_kiruna
anyride-profile-display: boreal
```

Without `anyride-profile-data`, endpoints such as `GetLines` may return data
for all Boreal areas instead of only Kiruna.

## Available calls

| Method | Endpoint | Input | Response |
|---|---|---|---|
| `GET` | `/GetConfigOptions` | Query: `profile`, `language` | `ConfigOptions` |
| `GET` | `/Autocomplete` | Query: `query` | `string[]` |
| `POST` | `/FindStopArea` | `FindStopAreaRequest` | `StopArea` or `null` |
| `POST` | `/FindStopsNearLocation` | `FindStopsNearLocationRequest` | `StopArea[]` |
| `GET` | `/GetLines` | None | `Line[]` |
| `GET` | `/GetDirections` | Query: `lineId` | `Direction[]` |
| `POST` | `/GetStopAreas` | `GetStopAreasRequest` | `StopArea[]` |
| `POST` | `/GetCalls` | `GetCallsRequest` | `GetCallsResponse` |
| `GET` | `/GetMapRoute` | Query: `routeId` | `MapRoute` |
| `GET` | `/GetVehiclePosition` | Query: `callId` | `VehiclePosition` or `null` |
| `GET` | `/GetVehiclePositions` | None | `VehiclePosition[]` |
| `GET` | `/GetSystemTimestamp` | Query: `clientTimestamp` | `SystemTimestamp` |

All request and response schemas are defined in
[`openapi.yaml`](openapi.yaml).

## Identifier flow

The APIs use several different identifiers:

| Identifier | Obtained from | Used by |
|---|---|---|
| `lineId` | `GetLines`, `GetCalls` | `GetDirections`, `GetStopAreas`, `GetCalls` |
| `routeId` | A call returned by `GetCalls` | `GetMapRoute` |
| `callId` | The `id` of a call returned by `GetCalls` | `GetVehiclePosition` |
| Stop query | `Autocomplete` or a `StopArea.text` value | `FindStopArea`, `GetCalls` |

`StopArea.id` and `StopArea.externalId` are numeric identifiers. The stop
query expected by `GetCalls` is normally the display string, for example
`Stadshustorget (84064)`, rather than only the numeric ID.

## Examples

### Configuration

```http
GET https://boreal.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api/GetConfigOptions?profile=&language=sv
```

The configuration response also contains map settings, localized UI text,
formatting settings, and asset URLs.

### Lines

```powershell
$headers = @{
    "anyride-profile-data" = "boreal_kiruna"
    "anyride-profile-display" = "boreal"
}

Invoke-RestMethod `
    -Uri "https://boreal.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api/GetLines" `
    -Headers $headers
```

The Kiruna line catalog observed on 2026-09-07 was:

```json
[
  {
    "id": 110000550,
    "text": "Grön - Grön. Tuolluvaara - Nya C - Lombolo - Gamla C - Porfyren"
  },
  {
    "id": 110000547,
    "text": "Gul. - Gul. Lombolo - Gamla Centrum - Porfyren"
  },
  {
    "id": 110000551,
    "text": "Lila. - Lila. Lombolo - Centrum - Hagelstigen - Porfyren"
  },
  {
    "id": 110000548,
    "text": "Röd. - Röd. Tuolluvaara - Nya Centrum - LKAB"
  }
]
```

### Stop autocomplete

```http
GET /Autocomplete?query=Stadshus
anyride-profile-data: boreal_kiruna
anyride-profile-display: boreal
```

Example response:

```json
[
  "Stadshustorget (84064)"
]
```

The query can contain either a stop name or a stop number.

### Stops for a line

```http
POST /GetStopAreas
Content-Type: application/json
anyride-profile-data: boreal_kiruna
anyride-profile-display: boreal

{
  "lineId": 110000550,
  "directionId": null
}
```

`directionId` may be `null` when the configuration property `useDirection` is
false.

### Nearby stops

```http
POST /FindStopsNearLocation
Content-Type: application/json
anyride-profile-data: boreal_kiruna
anyride-profile-display: boreal

{
  "coordinate": {
    "lat": 67.8558,
    "lon": 20.2253
  },
  "maxCount": null,
  "maxDistance": null
}
```

### Departures

```http
POST /GetCalls
Content-Type: application/json
anyride-profile-data: boreal_kiruna
anyride-profile-display: boreal

{
  "query": {
    "fromStopAreaQuery": "Stadshustorget (84064)",
    "toStopAreaName": "",
    "lineId": 0,
    "directionId": 0
  },
  "configuration": {
    "grouping": [
      "Line",
      "Destination1"
    ]
  }
}
```

The response groups departures by line and destination:

```json
{
  "isStopCancelled": false,
  "calls": [
    {
      "id": "l:110000548/dest1:110001090",
      "calls": [
        {
          "id": "84120839",
          "key": "1",
          "lineId": 110000548,
          "routeId": 540298,
          "journeyId": 15207312,
          "stopPointId": 118406401,
          "sequenceNumber": 4,
          "line": "Röd.",
          "lineAppearance": {
            "background": "#000000",
            "foreground": "#FFFFFF",
            "fontStyle": "regular"
          },
          "journey": "35",
          "destination": "LKAB Kiruna",
          "subdestination": "",
          "departure": {
            "journeyType": "Ordinary",
            "forecastTime": "2026-09-07T15:44:00+02:00",
            "plannedTime": "2026-09-07T15:44:00+02:00",
            "quality": "realtime",
            "attributes": [],
            "designation": "A"
          },
          "createdTime": "2026-09-07T15:35:30.3130578+02:00"
        }
      ]
    }
  ],
  "messages": []
}
```

A call can contain `arrival`, `departure`, or both. Forecast objects may also
contain `vehicleType` and `occupancyPercent`.

### Route geometry

Pass a `routeId` returned by `GetCalls`:

```http
GET /GetMapRoute?routeId=540298
anyride-profile-data: boreal_kiruna
anyride-profile-display: boreal
```

The response contains a line appearance and an ordered coordinate array.

### Vehicle position

Pass a call `id` returned by `GetCalls`:

```http
GET /GetVehiclePosition?callId=84120839
anyride-profile-data: boreal_kiruna
anyride-profile-display: boreal
```

The endpoint returns `null` when no live position is available.

## Sources

- Public page: <https://lokaltrafikenkiruna.se/realtidsinformation/>
- Embedded client: <https://boreal.tmix.se/anyride/>
- Client bootstrap configuration:
  <https://boreal.tmix.se/anyride/app.config.json>
- Client source map:
  <https://boreal.tmix.se/anyride/app.bundle.js.map>

