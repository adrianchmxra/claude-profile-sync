import path from 'node:path';
import fs from 'node:fs';
import {
  requireConfig,
  getClaudeDir,
  getProfilesDir,
  validateProfileName,
  acquireLock,
} from './config.js';
import { pullRepo } from './git.js';
import {
  copyProfile,
  diffProfile,
  loadProfileIgnore,
  assertProfileDevice,
} from './fs.js';
import { requireNoActiveSessions } from './session.js';

/**
 * Pull the active profile from the sync repo and copy it to ~/.claude.
 *
 * @param {object} options - { dryRun: boolean }
 */
export async function pull(options = {}) {
  const config = requireConfig();
  const profileName = config.activeProfile;
  if (!profileName) {
    throw new Error('No active profile set. Run "claude-profile init" first.');
  }
  validateProfileName(profileName);

  // Block if Claude Code is running to prevent config corruption
  requireNoActiveSessions();

  const releaseLock = acquireLock('pull');
  try {
    await _doPull(config, profileName, options);
  } finally {
    releaseLock();
  }
}

async function _doPull(config, profileName, options) {
  // Pull latest from remote
  console.log('Pulling latest from remote...');
  await pullRepo(config);

  const claudeDir = getClaudeDir();
  const profileDir = path.join(getProfilesDir(config), profileName);

  if (!fs.existsSync(profileDir)) {
    throw new Error(
      `Profile "${profileName}" not found in sync repo. ` +
        'Run "claude-profile list" to see available profiles.'
    );
  }

  // Device ownership guard: refuse if another device owns this profile.
  // --force bypasses (e.g. when reclaiming a profile after renaming a device).
  if (!options.force) {
    assertProfileDevice(profileDir, profileName, config.deviceId, 'pull from');
  }

  const ig = loadProfileIgnore(config);

  // Show what would change (diff in reverse: profile -> claude)
  const diff = diffProfile(profileDir, claudeDir, ig);

  if (options.dryRun) {
    console.log(`Dry run — pulling profile "${profileName}" to ~/.claude:`);
    if (!diff.changed) {
      console.log('  No changes to pull.');
    } else {
      console.log(`  ${diff.summary}`);
      if (diff.added.length > 0) {
        console.log('  New files:');
        for (const f of diff.added) console.log(`    + ${f}`);
      }
      if (diff.modified.length > 0) {
        console.log('  Modified files:');
        for (const f of diff.modified) console.log(`    ~ ${f}`);
      }
      if (diff.deleted.length > 0) {
        console.log('  Deleted files:');
        for (const f of diff.deleted) console.log(`    - ${f}`);
      }
    }
    return;
  }

  if (!diff.changed) {
    console.log(`~/.claude is already in sync with profile "${profileName}".`);
    return;
  }

  // Sync profile directory to ~/.claude (true sync with deletion of stale files)
  console.log(`Restoring profile "${profileName}" to ~/.claude... (${diff.summary})`);
  const result = copyProfile(profileDir, claudeDir, ig);
  const parts = [`Copied ${result.copied} files`];
  if (result.deleted > 0) parts.push(`deleted ${result.deleted} stale files`);
  console.log(`${parts.join(', ')}.`);
  console.log(`Profile "${profileName}" restored successfully.`);
}
