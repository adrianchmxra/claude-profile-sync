import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  requireConfig,
  saveConfig,
  getClaudeDir,
  getProfilesDir,
  readProfilesJson,
  validateProfileName,
  acquireLock,
} from './config.js';
import { pullRepo, commitAndPush } from './git.js';
import { copyProfile, diffProfile, loadProfileIgnore } from './fs.js';
import { requireNoActiveSessions } from './session.js';

/**
 * Switch to a different profile.
 *
 * ATOMICITY GUARANTEE:
 * ~/.claude is ONLY overwritten AFTER the snapshot of the current profile
 * has been successfully pushed to remote. If push fails at any point,
 * ~/.claude remains untouched.
 *
 * Flow:
 * 1. git pull (get latest remote state)
 * 2. Diff ~/.claude against profiles/<current>/
 * 3. If diff exists:
 *    a. Copy ~/.claude -> profiles/<current>/
 *    b. git add + commit "snapshot: <current> before switch to <target>"
 *    c. git push
 *    d. If push FAILS -> abort entirely, do NOT touch ~/.claude
 * 4. Copy profiles/<target>/ -> ~/.claude (overwrite)
 * 5. Update activeProfile in local config
 * 6. git add + commit "switch: <current> -> <target> on <deviceId>"
 * 7. git push
 *
 * @param {string} targetName - The profile to switch to
 */
export async function switchProfile(targetName) {
  if (!targetName) {
    throw new Error('Usage: claude-profile switch <profile-name>');
  }

  validateProfileName(targetName);

  const config = requireConfig();
  const currentName = config.activeProfile;

  if (targetName === currentName) {
    console.log(`Already on profile "${targetName}".`);
    return;
  }

  // Validate target profile exists
  const profilesData = readProfilesJson(config);
  const targetEntry = profilesData.profiles.find((p) => p.name === targetName);
  if (!targetEntry) {
    const available = profilesData.profiles.map((p) => p.name).join(', ');
    throw new Error(
      `Profile "${targetName}" not found. Available profiles: ${available || '(none)'}`
    );
  }

  // Block if Claude Code is running to prevent config corruption
  requireNoActiveSessions();

  const releaseLock = acquireLock('switch');
  try {
    await _doSwitch(config, currentName, targetName);
  } finally {
    releaseLock();
  }
}

async function _doSwitch(config, currentName, targetName) {
  const claudeDir = getClaudeDir();
  const profilesDir = getProfilesDir(config);
  const currentProfileDir = path.join(profilesDir, currentName);
  const targetProfileDir = path.join(profilesDir, targetName);

  // Step 1: Pull latest remote state
  console.log('Step 1/7: Pulling latest remote state...');
  await pullRepo(config);

  // Verify target profile directory exists after pull
  if (!fs.existsSync(targetProfileDir)) {
    throw new Error(
      `Profile directory for "${targetName}" not found in sync repo after pull. ` +
        'It may have been deleted from another device.'
    );
  }

  const ig = loadProfileIgnore(config);

  // Step 2: Diff ~/.claude against current profile
  console.log('Step 2/7: Checking for local changes...');
  const diff = diffProfile(claudeDir, currentProfileDir, ig);

  if (diff.changed) {
    // Step 3a: Snapshot current profile
    console.log(`Step 3/7: Saving local changes to "${currentName}"... (${diff.summary})`);
    if (!fs.existsSync(currentProfileDir)) {
      fs.mkdirSync(currentProfileDir, { recursive: true });
    }
    copyProfile(claudeDir, currentProfileDir, ig);

    // Step 3b-c: Commit and push snapshot
    console.log('Step 3/7: Pushing snapshot to remote...');
    const snapshotMsg = `snapshot: ${currentName} before switch to ${targetName}`;

    try {
      await commitAndPush(config, snapshotMsg);
    } catch (err) {
      // Step 3d: Push failed — ABORT. Do NOT touch ~/.claude.
      throw new Error(
        `ABORTED: Failed to push snapshot of "${currentName}". ` +
          `~/.claude was NOT modified.\n${err.message}`
      );
    }

    console.log('Snapshot pushed successfully.');
  } else {
    console.log('Step 3/7: No local changes to save. Skipping snapshot.');
  }

  // === POINT OF NO RETURN ===
  // Snapshot is safely on remote. Now overwrite ~/.claude.
  // Create a backup of ~/.claude so we can rollback if the copy fails.
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profile-backup-'));

  try {
    // Backup current syncable files from ~/.claude
    console.log('Creating backup of ~/.claude...');
    copyProfile(claudeDir, backupDir, ig);

    // Step 4: Copy target profile to ~/.claude
    console.log(`Step 4/7: Applying profile "${targetName}" to ~/.claude...`);
    const result = copyProfile(targetProfileDir, claudeDir, ig);
    const parts = [`Copied ${result.copied} files`];
    if (result.deleted > 0) parts.push(`deleted ${result.deleted} stale files`);
    console.log(`${parts.join(', ')}.`);
  } catch (err) {
    // Rollback: restore from backup
    console.error(`Failed to apply profile: ${err.message}`);
    console.log('Rolling back ~/.claude from backup...');
    try {
      copyProfile(backupDir, claudeDir, ig);
      console.log('Rollback successful. ~/.claude restored to previous state.');
    } catch (rollbackErr) {
      console.error(`CRITICAL: Rollback also failed: ${rollbackErr.message}`);
      console.error(`Manual recovery: backup is at ${backupDir}`);
      throw new Error(
        `Failed to apply profile and rollback failed. Backup at: ${backupDir}`
      );
    }
    throw err;
  }

  // Step 5: Update local config
  console.log('Step 5/7: Updating local config...');
  config.activeProfile = targetName;
  saveConfig(config);

  // Step 6-7: Commit and push the switch record
  console.log('Step 6/7: Recording switch in sync repo...');
  const switchMsg = `switch: ${currentName} -> ${targetName} on ${config.deviceId}`;

  try {
    await commitAndPush(config, switchMsg);
    console.log('Step 7/7: Push complete.');
  } catch (err) {
    // The switch already happened locally. Log warning but don't fail.
    console.error(
      `Warning: Switch completed locally but failed to push record: ${err.message}`
    );
    console.log('Run "claude-profile push" to sync the switch record later.');
  }

  // Clean up backup
  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  console.log('');
  console.log(`Switched from "${currentName}" to "${targetName}".`);
}
