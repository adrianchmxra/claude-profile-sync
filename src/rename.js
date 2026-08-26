import fs from 'node:fs';
import path from 'node:path';
import {
  requireConfig,
  getProfilesDir,
  readProfilesJson,
  writeProfilesJson,
  validateProfileName,
  acquireLock,
  saveConfig,
} from './config.js';
import { pullRepo, commitAndPush } from './git.js';

/**
 * Rename a profile in the sync repo.
 *
 * This is a repo-only operation: the profile directory is moved and the
 * profiles.json entry is relabelled. ~/.claude is never read or written, so
 * (unlike switch/pull/base pull) it is safe to run while Claude Code is
 * active.
 *
 * The profile's `.device-id` ownership marker moves with the directory, so
 * ownership is preserved — a rename is the same profile under a new label,
 * not a new profile.
 *
 * @param {string} oldName - The existing profile name
 * @param {string} newName - The desired profile name
 */
export async function renameProfile(oldName, newName) {
  if (!oldName || !newName) {
    throw new Error('Usage: claude-profile rename <old-name> <new-name>');
  }
  validateProfileName(oldName);
  validateProfileName(newName);

  if (oldName === newName) {
    throw new Error('Old and new profile names are identical.');
  }

  const config = requireConfig();

  const releaseLock = acquireLock('rename');
  try {
    console.log('Pulling latest from remote...');
    await pullRepo(config);

    const profilesData = readProfilesJson(config);
    const idx = profilesData.profiles.findIndex((p) => p.name === oldName);
    if (idx === -1) {
      throw new Error(`Profile "${oldName}" not found.`);
    }
    if (profilesData.profiles.some((p) => p.name === newName)) {
      throw new Error(`Profile "${newName}" already exists.`);
    }

    const profilesDir = getProfilesDir(config);
    const srcDir = path.join(profilesDir, oldName);
    const destDir = path.join(profilesDir, newName);

    // A profile entry can exist without a directory (e.g. one that has never
    // been pushed). Only move the directory when there is one to move.
    if (fs.existsSync(srcDir)) {
      if (fs.existsSync(destDir)) {
        throw new Error(
          `A directory for "${newName}" already exists in the repo. ` +
            'Resolve it manually before renaming.'
        );
      }
      fs.renameSync(srcDir, destDir);
    }

    profilesData.profiles[idx].name = newName;
    writeProfilesJson(config, profilesData);

    // Keep this device's active-profile pointer valid across the rename.
    let activeUpdated = false;
    if (config.activeProfile === oldName) {
      config.activeProfile = newName;
      saveConfig(config);
      activeUpdated = true;
    }

    console.log(`Renaming profile "${oldName}" -> "${newName}"...`);
    await commitAndPush(
      config,
      `rename: profile "${oldName}" -> "${newName}" from ${config.deviceId}`
    );

    console.log(`Profile renamed to "${newName}".`);
    if (activeUpdated) {
      console.log('Active profile pointer updated on this device.');
    }
    console.log(
      'Other devices still pointing at the old name will need to switch to the new one.'
    );
  } finally {
    releaseLock();
  }
}
