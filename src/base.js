import fs from 'node:fs';
import path from 'node:path';
import {
  requireConfig,
  getClaudeDir,
  getBaseDir,
  acquireLock,
} from './config.js';
import { pullRepo, commitAndPush } from './git.js';
import {
  loadProfileIgnore,
  isLayeredPath,
  getLayeredFiles,
  copyProfile,
  applyLayered,
} from './fs.js';
import { requireNoActiveSessions } from './session.js';

/**
 * The persistent base holds curated layered-region files (CLAUDE.md, agents/,
 * commands/, skills/) that are applied under every overlay profile. Adrian
 * curates it explicitly via `base add` / `base remove`. It starts empty and is
 * never touched by profile create/switch/delete.
 *
 * Subcommands:
 *   base show               list what's currently in base/
 *   base add <relpath>      copy a layered item from ~/.claude into base/
 *   base remove <relpath>   remove an item from base/
 *   base pull               apply base/ layered files to ~/.claude
 */
export async function base(sub, relpathParts = []) {
  const config = requireConfig();

  if (!sub) {
    printBaseUsage();
    return;
  }

  switch (sub) {
    case 'show':
      return baseShow(config);
    case 'add':
      return baseAdd(config, joinRelpath(relpathParts));
    case 'remove':
    case 'rm':
      return baseRemove(config, joinRelpath(relpathParts));
    case 'pull':
      return basePull(config);
    default:
      printBaseUsage();
      throw new Error(`Unknown base subcommand: ${sub}`);
  }
}

function printBaseUsage() {
  console.log(
    'Usage: claude-profile base <subcommand>\n\n' +
      'Subcommands:\n' +
      '  show               List the curated layered files in base/\n' +
      '  add <relpath>      Add a layered item (file or dir) from ~/.claude into base/\n' +
      '  remove <relpath>   Remove an item from base/\n' +
      '  pull               Apply base/ layered files to ~/.claude\n\n' +
      'The layered region is: CLAUDE.md, agents/, commands/, skills/.'
  );
}

function joinRelpath(parts) {
  if (Array.isArray(parts)) return parts.join(' ').trim();
  return String(parts || '').trim();
}

/**
 * Normalise + validate a user-supplied relative path targeting the layered
 * region inside ~/.claude or base/. Rejects absolute paths, traversal, and
 * anything outside the layered region.
 */
function normalizeLayeredRelpath(relpath) {
  if (!relpath) {
    throw new Error('A relative path is required (e.g. "agents/foo.md" or "commands").');
  }
  let rel = relpath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  rel = rel.replace(/\/+$/, ''); // drop trailing slash
  if (rel === '' || rel === '.') {
    throw new Error('Invalid path.');
  }
  if (rel.split('/').some((seg) => seg === '..')) {
    throw new Error('Path cannot contain "..".');
  }
  if (path.isAbsolute(relpath)) {
    throw new Error('Path must be relative to ~/.claude, not absolute.');
  }
  if (!isLayeredPath(rel)) {
    throw new Error(
      `"${rel}" is not in the layered region. ` +
        'Only CLAUDE.md, agents/, commands/, skills/ can be added to base.'
    );
  }
  return rel;
}

/**
 * List every syncable layered file currently stored in base/.
 */
function baseShow(config) {
  const baseDir = getBaseDir(config);
  const ig = loadProfileIgnore(config);
  if (!fs.existsSync(baseDir)) {
    console.log('base/ is empty. Nothing curated yet.');
    return;
  }
  const files = getLayeredFiles(baseDir, ig).sort();
  if (files.length === 0) {
    console.log('base/ is empty. Nothing curated yet.');
    return;
  }
  console.log('Base (persistent layered files applied under every overlay profile):');
  console.log('');
  for (const f of files) {
    console.log(`  ${f}`);
  }
  console.log('');
  console.log(`${files.length} file(s).`);
}

/**
 * Add a layered file or directory from ~/.claude into base/.
 * The item must exist in ~/.claude and be within the layered region.
 */
async function baseAdd(config, relpath) {
  const rel = normalizeLayeredRelpath(relpath);
  const claudeDir = getClaudeDir();
  const baseDir = getBaseDir(config);
  const ig = loadProfileIgnore(config);

  const src = path.join(claudeDir, rel);
  if (!fs.existsSync(src)) {
    throw new Error(`"${rel}" does not exist in ~/.claude.`);
  }

  const releaseLock = acquireLock('base-add');
  try {
    console.log('Pulling latest from remote...');
    await pullRepo(config);

    const stat = fs.statSync(src);
    let filesToCopy;
    if (stat.isDirectory()) {
      // All syncable layered files under this directory.
      const prefix = rel.endsWith('/') ? rel : rel + '/';
      filesToCopy = getLayeredFiles(claudeDir, ig).filter(
        (f) => f === rel || f.startsWith(prefix)
      );
    } else {
      // Single file — still respect ignore rules.
      filesToCopy = getLayeredFiles(claudeDir, ig).filter((f) => f === rel);
    }

    if (filesToCopy.length === 0) {
      throw new Error(
        `"${rel}" resolved to no syncable files (it may be excluded by .profileignore).`
      );
    }

    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
    // Additive copy scoped to exactly these files — never deletes anything
    // else already curated in base.
    const result = copyProfile(claudeDir, baseDir, ig, {
      additive: true,
      files: filesToCopy,
    });
    console.log(`Added ${result.copied} file(s) from "${rel}" to base.`);

    console.log('Pushing base update to remote...');
    await commitAndPush(config, `base: add "${rel}" from ${config.deviceId}`);
    console.log(`Base updated. "${rel}" is now part of the persistent base.`);
  } finally {
    releaseLock();
  }
}

/**
 * Remove a layered file or directory from base/.
 */
async function baseRemove(config, relpath) {
  const rel = normalizeLayeredRelpath(relpath);
  const baseDir = getBaseDir(config);

  const target = path.join(baseDir, rel);
  if (!fs.existsSync(target)) {
    throw new Error(`"${rel}" is not in base.`);
  }

  const releaseLock = acquireLock('base-remove');
  try {
    console.log('Pulling latest from remote...');
    await pullRepo(config);

    // Re-check after pull.
    if (!fs.existsSync(target)) {
      throw new Error(`"${rel}" is not in base (after pull).`);
    }

    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      fs.unlinkSync(target);
    }
    console.log(`Removed "${rel}" from base.`);

    console.log('Pushing base update to remote...');
    await commitAndPush(config, `base: remove "${rel}" from ${config.deviceId}`);
    console.log(`Base updated. "${rel}" is no longer part of the base.`);
  } finally {
    releaseLock();
  }
}

/**
 * Apply base/ layered files to ~/.claude without switching profiles.
 * This does a clean rebuild of the layered region using base only (no
 * overlay), so it adopts base and drops any layered files that base does
 * not provide. Non-layered data is never touched.
 */
async function basePull(config) {
  // Block if Claude Code is running to prevent config corruption.
  requireNoActiveSessions();

  const releaseLock = acquireLock('base-pull');
  try {
    console.log('Pulling latest from remote...');
    await pullRepo(config);

    const baseDir = getBaseDir(config);
    const claudeDir = getClaudeDir();
    const ig = loadProfileIgnore(config);

    // Clean rebuild of the layered region from base only (overlay = none).
    const result = applyLayered(baseDir, null, claudeDir, ig);
    const parts = [`applied ${result.fromBase} base file(s)`];
    if (result.removed > 0) parts.push(`removed ${result.removed} stale layered file(s)`);
    console.log(`Base applied to ~/.claude: ${parts.join(', ')}.`);
    console.log(
      'Non-layered data (credentials, mcp config, knowledge, history) was not touched.'
    );
  } finally {
    releaseLock();
  }
}
