import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.claude-profile');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Default configuration values.
 */
const DEFAULTS = {
  repoUrl: '',
  token: '',
  deviceId: `${os.hostname()}-${process.platform}`,
  activeProfile: '',
  clonePath: path.join(CONFIG_DIR, 'repo'),
};

/**
 * Files and directories inside ~/.claude that must NEVER be synced.
 */
export const ALWAYS_EXCLUDED = [
  '.claude.json',
  'projects',
  'teams',
  'tasks',
  'memory',
  'sessions',
  '.git',
];

/**
 * Get the path to the user's ~/.claude directory.
 */
export function getClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

/**
 * Get the path to the config directory (~/.claude-profile).
 */
export function getConfigDir() {
  return CONFIG_DIR;
}

/**
 * Ensure the config directory exists with proper permissions.
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  // chmod 700 on the config directory (Unix only)
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(CONFIG_DIR, 0o700);
    } catch {
      // Ignore permission errors (e.g. on some network filesystems)
    }
  }
}

/**
 * Read the local config file. Returns null if it doesn't exist.
 */
export function getConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (err) {
    throw new Error(`Failed to read config at ${CONFIG_FILE}: ${err.message}`);
  }
}

/**
 * Write the config file. Creates the directory if needed.
 * Token is stored locally only — never committed to the sync repo.
 */
export function saveConfig(config) {
  ensureConfigDir();
  const data = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(CONFIG_FILE, data, 'utf-8');
  // chmod 600 on the config file (Unix only — protects token)
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(CONFIG_FILE, 0o600);
    } catch {
      // Ignore
    }
  }
}

/**
 * Require that config exists and is initialized. Throws if not.
 */
export function requireConfig() {
  const config = getConfig();
  if (!config || !config.repoUrl || !config.token) {
    throw new Error(
      'claude-profile is not initialized. Run "claude-profile init" first.'
    );
  }
  return config;
}

/**
 * Get the absolute clone path (resolves ~ to homedir).
 */
export function getClonePath(config) {
  const p = config.clonePath || DEFAULTS.clonePath;
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

/**
 * Get the profiles directory inside the cloned repo.
 */
export function getProfilesDir(config) {
  return path.join(getClonePath(config), 'profiles');
}

/**
 * Get the profiles.json path inside the cloned repo.
 */
export function getProfilesJsonPath(config) {
  return path.join(getClonePath(config), 'profiles.json');
}

/**
 * Read profiles.json from the cloned repo. Returns the parsed object.
 */
export function readProfilesJson(config) {
  const p = getProfilesJsonPath(config);
  if (!fs.existsSync(p)) {
    return { version: 1, profiles: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return { version: 1, profiles: [] };
  }
}

/**
 * Write profiles.json to the cloned repo.
 */
export function writeProfilesJson(config, data) {
  const p = getProfilesJsonPath(config);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}
