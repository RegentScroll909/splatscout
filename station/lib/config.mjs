// Station configuration: tool locations (auto-detected), folders and defaults.
// Saved as <workDir>/station.config.json so you can edit it by hand.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';

const win = process.platform === 'win32';
const exe = (n) => (win ? n + '.exe' : n);

function onPath(name) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, exe(name));
    if (existsSync(p)) return p;
  }
  return null;
}

function firstExisting(paths) {
  return paths.find((p) => p && existsSync(p)) || null;
}

function wingetPackage(prefix, ...rest) {
  const base = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    const dir = readdirSync(base).find((d) => d.startsWith(prefix));
    return dir ? join(base, dir, ...rest) : null;
  } catch {
    return null;
  }
}

export function detectTools() {
  const la = process.env.LOCALAPPDATA || '';
  return {
    colmap: firstExisting([onPath('colmap'), 'C:\\Tools\\COLMAP\\bin\\colmap.exe', 'C:\\Program Files\\COLMAP\\bin\\colmap.exe']),
    brush: firstExisting([onPath('brush_app'), 'C:\\Tools\\Brush\\brush_app.exe']),
    ffmpeg: firstExisting([onPath('ffmpeg'), join(la, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')]),
    ffprobe: firstExisting([onPath('ffprobe'), join(la, 'Microsoft', 'WinGet', 'Links', 'ffprobe.exe')]),
    adb: firstExisting([onPath('adb'), wingetPackage('Google.PlatformTools', 'platform-tools', 'adb.exe'), join(la, 'Android', 'Sdk', 'platform-tools', 'adb.exe')]),
  };
}

export const PRESETS = {
  quick: { label: 'Quick preview (~5 min)', steps: 7000, maxResolution: 1280, maxSplats: 2_000_000 },
  standard: { label: 'Standard (~15–25 min)', steps: 30000, maxResolution: 1920, maxSplats: 6_000_000 },
  high: { label: 'High quality (~40+ min)', steps: 50000, maxResolution: 2560, maxSplats: 10_000_000 },
};

const DEFAULTS = {
  port: 8787,
  workDir: join(homedir(), 'SplatStation'),
  preset: 'standard',
  usePoses: true, // use SplatScout AR poses to guide COLMAP when available
  cropToBounds: true, // crop splats to the scan area marked in SplatScout 2.0
  adbAutoImport: true, // pull new SplatScout ZIPs from a USB-connected phone's Download folder
  matcher: 'auto', // auto | exhaustive | sequential
  tools: {},
};

export function loadConfig(overrides = {}) {
  const workDir = overrides.workDir || process.env.SPLATSTATION_DIR || DEFAULTS.workDir;
  const file = join(workDir, 'station.config.json');
  let saved = {};
  if (existsSync(file)) {
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.warn('Could not read', file, e.message);
    }
  }
  const detected = detectTools();
  const tools = { ...detected };
  for (const [k, v] of Object.entries(saved.tools || {})) if (v && existsSync(v)) tools[k] = v;
  const cfg = { ...DEFAULTS, ...saved, ...overrides, workDir, tools };
  cfg.dirs = {
    inbox: join(workDir, 'inbox'),
    jobs: join(workDir, 'jobs'),
    library: join(workDir, 'library'),
    imported: join(workDir, 'inbox', 'imported'),
  };
  for (const d of Object.values(cfg.dirs)) mkdirSync(d, { recursive: true });
  cfg.file = file;
  saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  const { dirs, file, ...rest } = cfg;
  writeFileSync(cfg.file, JSON.stringify(rest, null, 2));
}
