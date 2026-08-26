import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import { ALWAYS_EXCLUDED, getClonePath } from './config.js';

/**
 * The "layered region" of ~/.claude: the paths that are reconstructed as
 * base + overlay on every switch/pull for overlay profiles.
 *
 * A path is "in the layered region" if it equals 'CLAUDE.md' or lives under
 * 'agents/', 'commands/', or 'skills/'. Everything else (credentials, mcp
 * config, knowledge, history, caches, etc.) is NON-layered and is never
 * touched by the clean-rebuild logic.
 *
 * Defined as a single constant so the region is easy to change in one place.
 */
export const LAYERED_PATHS = ['CLAUDE.md', 'agents', 'commands', 'skills'];

/**
 * Test whether a relative path (forward-slash normalised) is inside the
 * layered region.
 *
 * @param {string} rel - relative path, e.g. "agents/foo.md" or "CLAUDE.md"
 * @returns {boolean}
 */
export function isLayeredPath(rel) {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const layered of LAYERED_PATHS) {
    if (norm === layered) return true;
    if (norm.startsWith(layered + '/')) return true;
  }
  return false;
}

/**
 * Split a list of relative file paths into { layered, nonLayered }.
 *
 * @param {string[]} files
 * @returns {{ layered: string[], nonLayered: string[] }}
 */
export function splitLayered(files) {
  const layered = [];
  const nonLayered = [];
  for (const f of files) {
    if (isLayeredPath(f)) layered.push(f);
    else nonLayered.push(f);
  }
  return { layered, nonLayered };
}

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
 * Sync files from srcDir to destDir.
 *
 * By default this is a TRUE SYNC: it copies all syncable files from source,
 * then deletes any syncable files in destDir that don't exist in srcDir, and
 * cleans up empty directories.
 *
 * With `{ additive: true }` it only copies (never deletes) — used when a set
 * of source files must be laid over an existing destination without removing
 * anything already there (e.g. applying non-layered overlay data on top of
 * the layered region).
 *
 * @param {string} srcDir
 * @param {string} destDir
 * @param {import('ignore').Ignore} ig
 * @param {{ additive?: boolean, files?: string[] }} [options]
 *   - additive: skip the deletion pass.
 *   - files: restrict the operation to this explicit list of relative paths
 *     (still filtered to those that actually exist in srcDir). When provided,
 *     the deletion pass (if any) is also scoped to this file set.
 * @returns {{ copied: number, deleted: number }}
 */
export function copyProfile(srcDir, destDir, ig, options = {}) {
  const { additive = false, files = null } = options;

  let srcFiles = getSyncableFiles(srcDir, ig);
  if (files) {
    const restrict = new Set(files.map((f) => f.replace(/\\/g, '/')));
    srcFiles = srcFiles.filter((f) => restrict.has(f));
  }
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
      // Remove any existing symlink at the destination so copyFileSync
      // doesn't fail trying to follow a broken symlink (ENOENT).
      try {
        const destStat = fs.lstatSync(destFile);
        if (destStat.isSymbolicLink()) {
          fs.unlinkSync(destFile);
        }
      } catch {
        // File doesn't exist, copyFileSync will create it
      }
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

  if (!additive) {
    // Delete syncable files in destination that don't exist in source.
    // When a `files` restriction is set, only consider that scope so we
    // never delete files outside the caller's declared region.
    let destFiles = getSyncableFiles(destDir, ig);
    if (files) {
      const restrict = new Set(files.map((f) => f.replace(/\\/g, '/')));
      destFiles = destFiles.filter((f) => restrict.has(f));
    }
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
  }

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
 * Report when a profile was last pushed by a different device.
 *
 * Device identity is METADATA, not authorization. A profile describes a
 * configuration, not a machine, so the same profile is expected to be used
 * from several devices at once. Treating the marker as ownership meant the
 * second device to touch a shared profile was refused outright.
 *
 * The property that actually matters — do not clobber newer remote state —
 * is enforced by pulling before a push and by git's non-fast-forward
 * rejection, not by this marker.
 *
 * @returns {string|null} the recorded device id, or null if never pushed
 */
export function noteProfileWriter(profileDir, profileName, localDeviceId, op) {
  const recorded = readProfileDeviceId(profileDir);
  if (recorded === null || recorded === localDeviceId) return recorded;
  console.log(
    `Note: profile "${profileName}" was last pushed by device "${recorded}". ` +
      `Continuing ${op} from "${localDeviceId}".`
  );
  return recorded;
}

// ---------------------------------------------------------------------------
// Layered region (base + overlay) helpers
// ---------------------------------------------------------------------------

/**
 * List the syncable files inside `dir` that fall within the layered region.
 *
 * @param {string} dir
 * @param {import('ignore').Ignore} ig
 * @returns {string[]} forward-slash relative paths
 */
export function getLayeredFiles(dir, ig) {
  return getSyncableFiles(dir, ig).filter((f) => isLayeredPath(f));
}

/**
 * Delete ONLY the layered-region files under `dir`. Non-layered files and
 * anything excluded by ALWAYS_EXCLUDED / .profileignore are left untouched.
 * Empty directories left behind inside the layered top-level dirs are removed.
 *
 * This is the destructive half of the clean rebuild. It is deliberately
 * scoped so credentials, mcp config, knowledge, history and caches can never
 * be removed by it.
 *
 * @param {string} dir - typically ~/.claude
 * @param {import('ignore').Ignore} ig
 * @returns {number} count of files removed
 */
export function cleanLayeredRegion(dir, ig) {
  const layeredFiles = getLayeredFiles(dir, ig);
  let removed = 0;
  for (const relFile of layeredFiles) {
    try {
      fs.unlinkSync(path.join(dir, relFile));
      removed++;
    } catch {
      // Ignore — file may already be gone
    }
  }
  // Clean up now-empty layered directories (agents/, commands/, skills/),
  // but never remove the top-level dir itself if other tooling expects it —
  // removeEmptyDirs only removes dirs that are genuinely empty.
  for (const layered of LAYERED_PATHS) {
    const layeredDir = path.join(dir, layered);
    if (fs.existsSync(layeredDir)) {
      try {
        const stat = fs.statSync(layeredDir);
        if (stat.isDirectory()) {
          removeEmptyDirs(layeredDir);
          // Remove the top-level layered dir if it is now empty.
          try {
            if (fs.readdirSync(layeredDir).length === 0) {
              fs.rmdirSync(layeredDir);
            }
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }
  }
  return removed;
}

/**
 * Clean-rebuild the layered region of `destDir` from base + overlay.
 *
 * 1. Delete existing layered-region files under destDir (only layered paths).
 * 2. Copy base layered files.
 * 3. Copy overlay layered files on top (overlay overrides base on conflicts).
 *
 * Non-layered data in destDir is never touched.
 *
 * @param {string} baseDir - the persistent base dir (may not exist / be empty)
 * @param {string} overlayDir - the profile's overlay dir (may not exist)
 * @param {string} destDir - typically ~/.claude
 * @param {import('ignore').Ignore} ig
 * @returns {{ removed: number, fromBase: number, fromOverlay: number }}
 */
export function applyLayered(baseDir, overlayDir, destDir, ig) {
  // 1. Clean the layered region.
  const removed = cleanLayeredRegion(destDir, ig);

  // 2. Copy base layered files (additive — layered region is now clean).
  let fromBase = 0;
  if (baseDir && fs.existsSync(baseDir)) {
    const baseLayered = getLayeredFiles(baseDir, ig);
    const res = copyProfile(baseDir, destDir, ig, {
      additive: true,
      files: baseLayered,
    });
    fromBase = res.copied;
  }

  // 3. Copy overlay layered files on top (additive — overrides base).
  let fromOverlay = 0;
  if (overlayDir && fs.existsSync(overlayDir)) {
    const overlayLayered = getLayeredFiles(overlayDir, ig);
    const res = copyProfile(overlayDir, destDir, ig, {
      additive: true,
      files: overlayLayered,
    });
    fromOverlay = res.copied;
  }

  return { removed, fromBase, fromOverlay };
}

/**
 * Compute the overlay delta for the layered region: the set of layered files
 * in `claudeDir` that are NOT byte-identical to the corresponding file in
 * `baseDir` (i.e. absent from base, or present but different). Files identical
 * to base are excluded — they are provided by the base, not the overlay.
 *
 * @param {string} claudeDir - typically ~/.claude
 * @param {string} baseDir - the persistent base dir
 * @param {import('ignore').Ignore} ig
 * @returns {string[]} forward-slash relative layered paths that belong in the overlay
 */
export function computeOverlayDelta(claudeDir, baseDir, ig) {
  const claudeLayered = getLayeredFiles(claudeDir, ig);
  const baseHasDir = baseDir && fs.existsSync(baseDir);
  const delta = [];

  for (const relFile of claudeLayered) {
    if (!baseHasDir) {
      delta.push(relFile);
      continue;
    }
    const baseFile = path.join(baseDir, relFile);
    if (!fs.existsSync(baseFile)) {
      delta.push(relFile);
      continue;
    }
    // Present in base — keep in overlay only if it differs from base.
    try {
      const claudeContent = fs.readFileSync(path.join(claudeDir, relFile));
      const baseContent = fs.readFileSync(baseFile);
      if (!claudeContent.equals(baseContent)) {
        delta.push(relFile);
      }
    } catch {
      // If we can't read one side, treat it as differing (safer: keep it).
      delta.push(relFile);
    }
  }

  return delta;
}

/**
 * Snapshot ~/.claude into an OVERLAY profile directory.
 *
 * The stored profile dir keeps a full NON-layered snapshot (true sync, as for
 * a legacy profile) plus, for the layered region, only the delta over base:
 *   - layered files absent from / differing from base are stored;
 *   - layered files identical to base are NOT stored;
 *   - layered files removed from ~/.claude are removed from the overlay;
 *   - a layered file that USED to differ from base but now matches base is
 *     removed from the overlay (kept a pure delta).
 *
 * This function performs the storage in two scoped passes so it never touches
 * non-layered data using layered logic (or vice versa):
 *   1. Non-layered: true-sync ~/.claude non-layered files into the profile.
 *   2. Layered: replace the profile's layered region with exactly the delta.
 *
 * @param {string} claudeDir
 * @param {string} baseDir
 * @param {string} profileDir
 * @param {import('ignore').Ignore} ig
 * @returns {{ nonLayered: {copied:number,deleted:number}, overlayFiles: string[] }}
 */
export function snapshotOverlayProfile(claudeDir, baseDir, profileDir, ig) {
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  const claudeSyncable = getSyncableFiles(claudeDir, ig);
  const { nonLayered } = splitLayered(claudeSyncable);

  // 1. Non-layered: true-sync (copy + delete stale) but scoped to the
  //    non-layered file set so layered files in the profile aren't deleted
  //    by this pass.
  const nonLayeredResult = copyProfile(claudeDir, profileDir, ig, {
    files: nonLayered,
  });

  // 2. Layered: compute the delta over base, then make the profile's layered
  //    region equal EXACTLY that delta.
  const delta = computeOverlayDelta(claudeDir, baseDir, ig);
  const deltaSet = new Set(delta);

  // Copy the delta layered files from ~/.claude into the profile (additive).
  if (delta.length > 0) {
    copyProfile(claudeDir, profileDir, ig, { additive: true, files: delta });
  }

  // Remove any layered files currently in the profile that are NOT in the
  // delta (identical-to-base, or deleted from ~/.claude, or previously-stored
  // stale overlay files).
  const profileLayered = getLayeredFiles(profileDir, ig);
  for (const relFile of profileLayered) {
    if (!deltaSet.has(relFile)) {
      try {
        fs.unlinkSync(path.join(profileDir, relFile));
      } catch {
        // ignore
      }
    }
  }
  for (const layered of LAYERED_PATHS) {
    const layeredDir = path.join(profileDir, layered);
    if (fs.existsSync(layeredDir)) {
      try {
        if (fs.statSync(layeredDir).isDirectory()) {
          removeEmptyDirs(layeredDir);
          try {
            if (fs.readdirSync(layeredDir).length === 0) {
              fs.rmdirSync(layeredDir);
            }
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return { nonLayered: nonLayeredResult, overlayFiles: delta };
}
