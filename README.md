# Boreal AnyRide API

This folder documents the JSON API used by the real-time information page at
<https://lokaltrafikenkiruna.se/realtidsinformation/>.

The page embeds the Boreal AnyRide client at <https://boreal.tmix.se/anyride/>.
The client calls an undocumented HTTP API:

```text
https://boreal.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api/
```

The machine-readable contract is available in [openapi.yaml](openapi.yaml).

## Support and stability

This is an internal API used by the public AnyRide web client. It does not
publish Swagger or other official API documentation. No authentication was
required when the API was inspected on 2026-09-07, but endpoints, headers, and
response formats may change without notice.

The browser API currently allows cross-origin requests, including the two
AnyRide profile headers described below.

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

