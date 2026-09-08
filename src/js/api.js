// Thin wrapper over the Boreal AnyRide API (see /README.md and /openapi.yaml).
const BASE_URL = 'https://boreal.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api';
const DEFAULT_TIMEOUT_MS = 10000;

export class ApiError extends Error {
  constructor(message, { endpoint, status, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.endpoint = endpoint;
    this.status = status;
    this.cause = cause;
  }
}

// Set once GetConfigOptions resolves; every other endpoint requires these.
let profileHeaders = null;

export function setProfileHeaders(headers) {
  profileHeaders = headers;
}

function buildUrl(path, query) {
  const url = new URL(BASE_URL + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function request(
  path,
  { method = 'GET', query, body, signal, requireProfile = true, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  if (requireProfile && !profileHeaders) {
    throw new ApiError(`Profile headers not initialized before calling ${path}`, { endpoint: path });
  }

  const headers = requireProfile ? { ...profileHeaders } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // Combine an optional caller-provided abort signal with a timeout guard.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }

  let response;
  try {
    response = await fetch(buildUrl(path, method === 'GET' ? query : undefined), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw err; // propagate cancellation/timeout as-is
    throw new ApiError(`Network error calling ${path}: ${err.message}`, { endpoint: path, cause: err });
  }
  clearTimeout(timeout);

  if (!response.ok) {
    throw new ApiError(`${path} responded with ${response.status}`, { endpoint: path, status: response.status });
  }

  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ApiError(`${path} returned invalid JSON`, { endpoint: path, cause: err });
  }
}

export const api = {
  getConfigOptions: (profile = '', language = 'sv', opts = {}) =>
    request('/GetConfigOptions', { query: { profile, language }, requireProfile: false, ...opts }),

  autocomplete: (query, opts = {}) => request('/Autocomplete', { query: { query }, ...opts }),

  findStopArea: (stopAreaQuery, opts = {}) =>
    request('/FindStopArea', { method: 'POST', body: { StopAreaQuery: stopAreaQuery }, ...opts }),

  findStopsNearLocation: (coordinate, { maxCount = null, maxDistance = null } = {}, opts = {}) =>
    request('/FindStopsNearLocation', { method: 'POST', body: { coordinate, maxCount, maxDistance }, ...opts }),

  getLines: (opts = {}) => request('/GetLines', opts),

  getDirections: (lineId, opts = {}) => request('/GetDirections', { query: { lineId }, ...opts }),

  getStopAreas: (lineId, directionId = null, opts = {}) =>
    request('/GetStopAreas', { method: 'POST', body: { lineId, directionId }, ...opts }),

  getCalls: ({ fromStopAreaQuery, toStopAreaName = '', lineId = 0, directionId = 0 }, opts = {}) =>
    request('/GetCalls', {
      method: 'POST',
      body: {
        query: { fromStopAreaQuery, toStopAreaName, lineId, directionId },
        configuration: { grouping: ['Line', 'Destination1'] },
      },
      ...opts,
    }),

  getMapRoute: (routeId, opts = {}) => request('/GetMapRoute', { query: { routeId }, ...opts }),

  getVehiclePosition: (callId, opts = {}) => request('/GetVehiclePosition', { query: { callId }, ...opts }),

  getVehiclePositions: (opts = {}) => request('/GetVehiclePositions', opts),

  getSystemTimestamp: (clientTimestamp, opts = {}) =>
    request('/GetSystemTimestamp', { query: { clientTimestamp }, ...opts }),
};
