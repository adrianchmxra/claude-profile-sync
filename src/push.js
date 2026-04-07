import path from 'node:path';
import {
  requireConfig,
  getClaudeDir,
  getProfilesDir,
  readProfilesJson,
  writeProfilesJson,
  validateProfileName,
  acquireLock,
} from './config.js';
import { pullRepo, commitAndPush, forcePush } from './git.js';
import {
  copyProfile,
  diffProfile,
  loadProfileIgnore,
  assertProfileDevice,
  writeProfileDeviceId,
} from './fs.js';

/**
 * Push current ~/.claude state to the active profile in the sync repo.
 *
 * @param {object} options - { force: boolean, dryRun: boolean }
 */
export async function push(options = {}) {
  const config = requireConfig();
  const profileName = config.activeProfile;
  if (!profileName) {
    throw new Error('No active profile set. Run "claude-profile init" first.');
  }
  validateProfileName(profileName);

  const releaseLock = acquireLock('push');
  try {
    await _doPush(config, profileName, options);
  } finally {
    releaseLock();
  }
}

async function _doPush(config, profileName, options) {
  const claudeDir = getClaudeDir();
  const profileDir = path.join(getProfilesDir(config), profileName);
  const ig = loadProfileIgnore(config);

  // Show what would change
  const diff = diffProfile(claudeDir, profileDir, ig);

  if (options.dryRun) {
    console.log(`Dry run for profile "${profileName}":`);
    if (!diff.changed) {
      console.log('  No changes to push.');
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
    console.log(`Profile "${profileName}" is already up to date.`);
    return;
  }

  // Pull latest first (unless --force)
  if (!options.force) {
    console.log('Pulling latest remote state...');
    await pullRepo(config);
  }

  // Device ownership guard: refuse if another device owns this profile.
  // --force bypasses (e.g. when reclaiming a profile after renaming a device).
  if (!options.force) {
    assertProfileDevice(profileDir, profileName, config.deviceId, 'push to');
  }

  // Copy ~/.claude into profile directory
  console.log(`Copying ~/.claude to profile "${profileName}"... (${diff.summary})`);
  const result = copyProfile(claudeDir, profileDir, ig);
  const parts = [`Copied ${result.copied} files`];
  if (result.deleted > 0) parts.push(`deleted ${result.deleted} stale files`);
  console.log(`${parts.join(', ')}.`);

  // Stamp this device as the current owner of the profile.
  writeProfileDeviceId(profileDir, config.deviceId);

  // Update profiles.json timestamp
  const profilesData = readProfilesJson(config);
  const profileEntry = profilesData.profiles.find((p) => p.name === profileName);
  if (profileEntry) {
    profileEntry.lastPushedAt = new Date().toISOString();
    writeProfilesJson(config, profilesData);
  }

  // Commit and push
  const commitMsg = `push: ${profileName} from ${config.deviceId} (${diff.summary})`;
  console.log('Pushing to remote...');

  if (options.force) {
    await forcePush(config, commitMsg);
  } else {
    await commitAndPush(config, commitMsg);
  }

  console.log(`Profile "${profileName}" pushed successfully.`);
}
