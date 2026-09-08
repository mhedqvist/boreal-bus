import { api, setProfileHeaders, ApiError } from './api.js';

let configPromise = null;
let configOptions = null;

// Must resolve before any other endpoint is called (they all require the
// anyride-profile-data/anyride-profile-display headers this returns).
export async function loadConfig() {
  if (configOptions) return configOptions;
  if (!configPromise) {
    configPromise = (async () => {
      const cfg = await api.getConfigOptions('', 'sv');
      if (!cfg || !cfg.profileData || !cfg.profileDisplay) {
        throw new ApiError('GetConfigOptions response is missing profileData/profileDisplay');
      }
      setProfileHeaders({
        'anyride-profile-data': cfg.profileData,
        'anyride-profile-display': cfg.profileDisplay,
      });
      configOptions = cfg;
      return cfg;
    })();
  }
  return configPromise;
}

export function getConfig() {
  return configOptions;
}
