import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Resolve the "home" directory that anchors ~/.claude and ~/.claude-profile.
 *
 * Normally this is the real OS home directory. For testing (and only for
 * testing) it can be overridden via the CLAUDE_PROFILE_HOME environment
 * variable so a self-contained sandbox can point the CLI away from the
 * user's live data. This is read lazily on every call so tests can set it
 * before importing/invoking any command.
 */
export function getHomeDir() {
  const override = process.env.CLAUDE_PROFILE_HOME;
  if (override && override.trim()) {
    return override.trim();
  }
  return os.homedir();
}

const CONFIG_FILE_NAME = 'config.json';

/**
 * Path to the config directory (~/.claude-profile). Computed lazily so the
 * CLAUDE_PROFILE_HOME override is honoured even if it changes between calls.
 */
function configDir() {
  return path.join(getHomeDir(), '.claude-profile');
}

function configFile() {
  return path.join(configDir(), CONFIG_FILE_NAME);
}

/**
 * Default configuration values. Computed lazily so the CLAUDE_PROFILE_HOME
 * override affects the default clonePath.
 */
function defaults() {
  return {
    repoUrl: '',
    deviceId: `${os.hostname()}-${process.platform}`,
    activeProfile: '',
    clonePath: path.join(configDir(), 'repo'),
  };
}

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
  '.device-id',
];

/**
 * Validate a profile name. Throws if the name contains path traversal
 * characters or doesn't match the allowed pattern.
 *
 * @param {string} name - The profile name to validate
 * @returns {string} The validated name (trimmed)
 */
export function validateProfileName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Profile name is required.');
  }

  const trimmed = name.trim();

  if (trimmed.length === 0) {
    throw new Error('Profile name cannot be empty.');
  }

  // Reject path traversal patterns
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(
      'Profile name cannot contain "..", "/", or "\\". ' +
        'Only letters, numbers, spaces, hyphens, and underscores are allowed.'
    );
  }

  // Allow letters, numbers, spaces, hyphens, underscores
  if (!/^[a-zA-Z0-9 _-]+$/.test(trimmed)) {
    throw new Error(
      'Profile name can only contain letters, numbers, spaces, hyphens, and underscores.'
    );
  }

  return trimmed;
}

/**
 * Get the path to the user's ~/.claude directory.
 */
export function getClaudeDir() {
  return path.join(getHomeDir(), '.claude');
}

/**
 * Get the path to the config directory (~/.claude-profile).
 */
export function getConfigDir() {
  return configDir();
}

/**
 * Ensure the config directory exists with proper permissions.
 */
function ensureConfigDir() {
  const dir = configDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // chmod 700 on the config directory (Unix only)
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Ignore permission errors (e.g. on some network filesystems)
    }
  }
}

/**
 * Read the local config file. Returns null if it doesn't exist.
 *
 * Migration: older configs cached a `token` field on disk. We drop it
 * on read AND rewrite the file without it, so any previously-saved
 * secret is scrubbed from disk on the next CLI invocation. The token
 * is now resolved at runtime from `gh auth token` (see git.js).
 */
export function getConfig() {
  const file = configFile();
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Object.prototype.hasOwnProperty.call(parsed, 'token')) {
      delete parsed.token;
      // Rewrite without the token to scrub the secret from disk.
      try {
        saveConfig(parsed);
      } catch {
        // If we can't rewrite (e.g. read-only fs), ignore — the in-memory
        // copy is still safe and we'll try again next time.
      }
    }
    return { ...defaults(), ...parsed };
  } catch (err) {
    throw new Error(`Failed to read config at ${file}: ${err.message}`);
  }
}

/**
 * Write the config file. Creates the directory if needed.
 * No secrets are stored here — the GitHub token is fetched at runtime.
 */
export function saveConfig(config) {
  ensureConfigDir();
  // Defensive: never persist a token field even if a caller passed one.
  const { token: _drop, ...safe } = config;
  const data = JSON.stringify(safe, null, 2) + '\n';
  const file = configFile();
  fs.writeFileSync(file, data, 'utf-8');
  // chmod 600 on the config file (Unix only — minor hardening)
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
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
  if (!config || !config.repoUrl) {
    throw new Error(
      'claude-profile is not initialized. Run "claude-profile init" first.'
    );
  }
  // Validate activeProfile to prevent path traversal from corrupted config
  if (config.activeProfile) {
    validateProfileName(config.activeProfile);
  }
  return config;
}

/**
 * Get the absolute clone path (resolves ~ to homedir).
 */
export function getClonePath(config) {
  const p = config.clonePath || defaults().clonePath;
  if (p.startsWith('~')) {
    return path.join(getHomeDir(), p.slice(1));
  }
  return path.resolve(p);
}

/**
 * Get the base directory inside the cloned repo. The base holds the
 * persistent, curated layered-region files (CLAUDE.md, agents/, commands/,
 * skills/) that are applied under every overlay profile.
 */
export function getBaseDir(config) {
  return path.join(getClonePath(config), 'base');
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
 * Check if a process with the given PID is currently running.
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire a lock file before destructive operations.
 * Throws if another operation is already running (with a live PID).
 *
 * @param {string} operation - Name of the operation (push, pull, switch, delete)
 * @returns {function} A release function to call when done
 */
export function acquireLock(operation) {
  const lockPath = path.join(configDir(), '.lock');

  // Check for existing lock
  if (fs.existsSync(lockPath)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      if (lockData.pid && isProcessAlive(lockData.pid) && lockData.pid !== process.pid) {
        throw new Error(
          `Another operation "${lockData.operation}" is already running (PID ${lockData.pid}). ` +
            'Wait for it to finish or remove ~/.claude-profile/.lock if it is stale.'
        );
      }
    } catch (err) {
      // If the error is our lock error, rethrow it
      if (err.message.includes('Another operation')) {
        throw err;
      }
      // Otherwise the lock file is corrupt, remove it
    }
  }

  // Write lock
  ensureConfigDir();
  const lockData = {
    pid: process.pid,
    operation,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2) + '\n', 'utf-8');

  // Return release function
  return function releaseLock() {
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  };
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

/**
 * Whether a given profile is in base+overlay mode.
 *
 * A profile is an overlay profile only if its profiles.json entry has
 * `overlay: true`. Absent or false means legacy full-snapshot behaviour,
 * which is preserved exactly as before.
 *
 * @param {object} config
 * @param {string} profileName
 * @returns {boolean}
 */
export function isOverlayProfile(config, profileName) {
  const data = readProfilesJson(config);
  const entry = data.profiles.find((p) => p.name === profileName);
  return !!(entry && entry.overlay === true);
}
