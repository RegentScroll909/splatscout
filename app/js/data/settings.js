// User preferences (per device).

const KEY = 'splatscout.settings';

export const DEFAULTS = {
  author: '',
  voice: true,
  sounds: true,
  strictness: 'standard', // relaxed | standard | strict
  engine: 'auto', // auto | xr | camera
  resolution: '4k',
  cameraId: '',
  jpegQuality: 0.92,
  arFlipY: true,
  showDebug: false,
  overlayVoxels: true,
  stationUrl: '', // SplatStation on your PC, e.g. http://192.168.1.20:8787
};

let cache = null;

export function getSettings() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {}
  cache = { ...DEFAULTS, ...saved };
  return cache;
}

export function setSettings(patch) {
  cache = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {}
  return cache;
}
