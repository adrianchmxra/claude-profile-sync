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
 * Copy syncable files from srcDir to destDir.
 * Only copies files not excluded by .profileignore + hardcoded exclusions.
 * Does NOT delete files in destDir that aren't in srcDir (additive copy).
 */
export function copyProfile(srcDir, destDir, ig) {
  const files = getSyncableFiles(srcDir, ig);
  let copied = 0;
  const failed = [];

  for (const relFile of files) {
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
      `Failed to copy ${failed.length} of ${files.length} files:\n${failList}`
    );
  }

  return copied;
}

/**
 * Check if there are differences between srcDir and destDir for syncable files.
 * Returns an object: { changed: boolean, added: string[], modified: string[], summary: string }
 */
export function diffProfile(srcDir, destDir, ig) {
  const srcFiles = getSyncableFiles(srcDir, ig);
  const destFiles = new Set(getSyncableFiles(destDir, ig));

  const added = [];
  const modified = [];

  for (const relFile of srcFiles) {
    const srcFile = path.join(srcDir, relFile);
    const destFile = path.join(destDir, relFile);

    if (!destFiles.has(relFile)) {
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

  const changed = added.length > 0 || modified.length > 0;
  const parts = [];
  if (added.length > 0) parts.push(`${added.length} new`);
  if (modified.length > 0) parts.push(`${modified.length} modified`);
  const summary = changed ? parts.join(', ') : 'no changes';

  return { changed, added, modified, summary };
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
