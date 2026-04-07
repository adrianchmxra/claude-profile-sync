import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import { ALWAYS_EXCLUDED, getClonePath } from './config.js';

/**
 * Parse .profileignore from the sync repo root.
 * Returns an `ignore` instance that can test paths.
 */
export function loadProfileIgnore(config) {
  const ig = ignore();

  // Always exclude hardcoded paths
  for (const excl of ALWAYS_EXCLUDED) {
    ig.add(excl);
  }

  // Load .profileignore from repo root if it exists
  const ignorePath = path.join(getClonePath(config), '.profileignore');
  if (fs.existsSync(ignorePath)) {
    const content = fs.readFileSync(ignorePath, 'utf-8');
    ig.add(content);
  }

  return ig;
}

/**
 * Recursively list all files in a directory, returning paths relative to `baseDir`.
 * Follows the directory structure but does not follow symlinks.
 */
function walkDir(baseDir) {
  const results = [];

  if (!fs.existsSync(baseDir)) {
    return results;
  }

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        // Add directory marker for ignore matching (trailing /)
        results.push(relPath + '/');
        walk(fullPath);
      } else if (entry.isFile()) {
        results.push(relPath);
      }
      // Skip symlinks and other special files
    }
  }

  walk(baseDir);
  return results;
}

/**
 * Get all syncable files from a directory, filtered through .profileignore.
 * Returns an array of relative paths (files only, no directories).
 */
export function getSyncableFiles(dir, ig) {
  const allPaths = walkDir(dir);
  // Normalize separators to forward slashes for ignore matching
  const normalized = allPaths.map((p) => p.replace(/\\/g, '/'));
  // Filter: keep only files (no trailing /), and not ignored
  const files = normalized.filter((p) => {
    if (p.endsWith('/')) return false;
    return !ig.ignores(p);
  });
  return files;
}

/**
 * Sync files from srcDir to destDir (true sync).
 * Copies all syncable files from source, then deletes any syncable files
 * in destDir that don't exist in srcDir. Cleans up empty directories after.
 */
export function copyProfile(srcDir, destDir, ig) {
  const srcFiles = getSyncableFiles(srcDir, ig);
  const srcFileSet = new Set(srcFiles);
  let copied = 0;
  let deleted = 0;
  const failed = [];

  // Copy all source files to destination
  for (const relFile of srcFiles) {
    const srcFile = path.join(srcDir, relFile);
    const destFile = path.join(destDir, relFile);

    // Ensure destination directory exists
    const destParent = path.dirname(destFile);
    if (!fs.existsSync(destParent)) {
      fs.mkdirSync(destParent, { recursive: true });
    }

    try {
      fs.copyFileSync(srcFile, destFile);
      copied++;
    } catch (err) {
      failed.push({ file: relFile, error: err.message });
    }
  }

  if (failed.length > 0) {
    const failList = failed.map((f) => `  ${f.file}: ${f.error}`).join('\n');
    throw new Error(
      `Failed to copy ${failed.length} of ${srcFiles.length} files:\n${failList}`
    );
  }

  // Delete syncable files in destination that don't exist in source
  const destFiles = getSyncableFiles(destDir, ig);
  for (const relFile of destFiles) {
    if (!srcFileSet.has(relFile)) {
      try {
        fs.unlinkSync(path.join(destDir, relFile));
        deleted++;
      } catch {
        // Ignore deletion errors for files that may already be gone
      }
    }
  }

  // Clean up empty directories left behind
  removeEmptyDirs(destDir);

  return { copied, deleted };
}

/**
 * Recursively remove empty directories under baseDir.
 * Walks bottom-up so nested empty dirs are cleaned properly.
 */
function removeEmptyDirs(baseDir) {
  if (!fs.existsSync(baseDir)) return;

  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const fullPath = path.join(baseDir, entry.name);
      removeEmptyDirs(fullPath);
      // After cleaning children, remove if now empty
      try {
        const remaining = fs.readdirSync(fullPath);
        if (remaining.length === 0) {
          fs.rmdirSync(fullPath);
        }
      } catch {
        // Ignore errors
      }
    }
  }
}

/**
 * Check if there are differences between srcDir and destDir for syncable files.
 * Returns an object: { changed, added, modified, deleted, summary }
 */
export function diffProfile(srcDir, destDir, ig) {
  const srcFiles = getSyncableFiles(srcDir, ig);
  const srcFileSet = new Set(srcFiles);
  const destFiles = getSyncableFiles(destDir, ig);
  const destFileSet = new Set(destFiles);

  const added = [];
  const modified = [];
  const deleted = [];

  for (const relFile of srcFiles) {
    const srcFile = path.join(srcDir, relFile);
    const destFile = path.join(destDir, relFile);

    if (!destFileSet.has(relFile)) {
      added.push(relFile);
      continue;
    }

    // Compare file contents
    try {
      const srcContent = fs.readFileSync(srcFile);
      const destContent = fs.readFileSync(destFile);
      if (!srcContent.equals(destContent)) {
        modified.push(relFile);
      }
    } catch {
      modified.push(relFile);
    }
  }

  // Files in destination that don't exist in source
  for (const relFile of destFiles) {
    if (!srcFileSet.has(relFile)) {
      deleted.push(relFile);
    }
  }

  const changed = added.length > 0 || modified.length > 0 || deleted.length > 0;
  const parts = [];
  if (added.length > 0) parts.push(`${added.length} new`);
  if (modified.length > 0) parts.push(`${modified.length} modified`);
  if (deleted.length > 0) parts.push(`${deleted.length} deleted`);
  const summary = changed ? parts.join(', ') : 'no changes';

  return { changed, added, modified, deleted, summary };
}

/**
 * Ensure a profile directory exists inside the cloned repo.
 */
export function ensureProfileDir(config, profileName) {
  const dir = path.join(getClonePath(config), 'profiles', profileName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Path to the device-id marker file inside a profile directory.
 * The marker records which deviceId last pushed to this profile, so
 * pull/push from a different device can be detected and refused.
 */
function getDeviceMarkerPath(profileDir) {
  return path.join(profileDir, '.device-id');
}

/**
 * Read the recorded deviceId from a profile dir, or null if no marker.
 */
export function readProfileDeviceId(profileDir) {
  const p = getDeviceMarkerPath(profileDir);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Write the local deviceId into a profile dir as the new owner marker.
 */
export function writeProfileDeviceId(profileDir, deviceId) {
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }
  fs.writeFileSync(getDeviceMarkerPath(profileDir), deviceId + '\n', 'utf-8');
}

/**
 * Check that the profile's recorded deviceId matches the local one.
 * Throws a descriptive error if they mismatch. A profile with no marker
 * yet is considered claimable (returns without error).
 */
export function assertProfileDevice(profileDir, profileName, localDeviceId, op) {
  const recorded = readProfileDeviceId(profileDir);
  if (recorded === null) return; // unclaimed — first push will stamp it
  if (recorded === localDeviceId) return;
  throw new Error(
    `Refusing to ${op} profile "${profileName}": this profile is owned by ` +
      `device "${recorded}", but the local device is "${localDeviceId}". ` +
      `If this is intentional (e.g. you renamed a device or are reclaiming ` +
      `the profile), re-run with --force to override.`
  );
}
