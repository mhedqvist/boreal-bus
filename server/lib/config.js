import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;

function list(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// STATIC_DIR=off turns static hosting off (API only).
function resolveStaticDir() {
  if (env.STATIC_DIR === 'off') return null;
  if (env.STATIC_DIR) return path.resolve(env.STATIC_DIR);
  return fileURLToPath(new URL('../../src', import.meta.url));
}

export const config = {
  port: Number(env.PORT) || 8080,
  host: env.HOST || '0.0.0.0',
  borealBase: (env.BOREAL_BASE || 'https://boreal.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api').replace(/\/+$/, ''),
  profileData: env.BOREAL_PROFILE_DATA || 'boreal_kiruna',
  profileDisplay: env.BOREAL_PROFILE_DISPLAY || 'boreal',
  upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS) || 10000,
  // Origins allowed to call /api from a browser on another site. The
  // bundled frontend is same-origin and needs no entry. "*" allows all.
  allowedOrigins: list(env.ALLOWED_ORIGINS ?? 'https://mhedqvist.github.io'),
  staticDir: resolveStaticDir(),
};
