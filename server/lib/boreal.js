import { config } from './config.js';

export class UpstreamError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.cause = cause;
  }
}

// Low-level call to the Boreal AnyRide API. Returns the raw status, content
// type and body so the passthrough can relay it unchanged. Every endpoint
// except GetConfigOptions needs the profile headers, which are added here
// so browsers never have to know them.
export async function borealRequest(path, { method = 'GET', search = '', body, profile = true } = {}) {
  const headers = {};
  if (profile) {
    headers['anyride-profile-data'] = config.profileData;
    headers['anyride-profile-display'] = config.profileDisplay;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetch(config.borealBase + path + search, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
  } catch (err) {
    throw new UpstreamError(`Request to ${path} failed: ${err.message}`, { cause: err });
  }

  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

async function borealJson(path, options) {
  const res = await borealRequest(path, options);
  if (res.status < 200 || res.status >= 300) {
    throw new UpstreamError(`${path} responded with ${res.status}`, { status: res.status });
  }
  const text = res.body.toString('utf8');
  try {
    return text ? JSON.parse(text) : null;
  } catch (err) {
    throw new UpstreamError(`${path} returned invalid JSON`, { cause: err });
  }
}

// Typed helpers used by the tracker (request shapes match openapi.yaml).
export const boreal = {
  getLines: () => borealJson('/GetLines'),

  getStopAreas: (lineId) =>
    borealJson('/GetStopAreas', { method: 'POST', body: JSON.stringify({ lineId, directionId: null }) }),

  findStopArea: (stopText) =>
    borealJson('/FindStopArea', { method: 'POST', body: JSON.stringify({ StopAreaQuery: stopText }) }),

  getCalls: (stopText) =>
    borealJson('/GetCalls', {
      method: 'POST',
      body: JSON.stringify({
        query: { fromStopAreaQuery: stopText, toStopAreaName: '', lineId: 0, directionId: 0 },
        configuration: { grouping: ['Line', 'Destination1'] },
      }),
    }),

  getVehiclePosition: (callId) =>
    borealJson('/GetVehiclePosition', { search: `?callId=${encodeURIComponent(callId)}` }),

  getSystemTimestamp: (clientTimestamp) =>
    borealJson('/GetSystemTimestamp', { search: `?clientTimestamp=${encodeURIComponent(clientTimestamp)}` }),
};
