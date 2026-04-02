import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  requireConfig,
  getProfilesDir,
  readProfilesJson,
  writeProfilesJson,
  validateProfileName,
  acquireLock,
} from './config.js';
import { pullRepo, commitAndPush } from './git.js';

/**
 * Delete a profile from the sync repo.
 *
 * @param {string} name - The profile name to delete
 * @param {object} options - { yes: boolean } - skip confirmation if true
 */
export async function deleteProfile(name, options = {}) {
  if (!name) {
    throw new Error('Usage: claude-profile delete <name>');
  }
  validateProfileName(name);

  const config = requireConfig();

  if (name === config.activeProfile) {
    throw new Error(
      `Cannot delete the active profile "${name}". ` +
        'Switch to a different profile first.'
    );
  }

  // Pull latest
  await pullRepo(config);

  // Check profile exists
  const profilesData = readProfilesJson(config);
  const profileIndex = profilesData.profiles.findIndex((p) => p.name === name);
  if (profileIndex === -1) {
    throw new Error(`Profile "${name}" not found.`);
  }

  // Confirm unless --yes
  if (!options.yes) {
    const confirmed = await confirm(
      `Delete profile "${name}"? This cannot be undone. (y/N) `
    );
    if (!confirmed) {
      console.log('Cancelled.');
      return;
    }
  }

  const releaseLock = acquireLock('delete');
  try {
    // Remove profile directory
    const profileDir = path.join(getProfilesDir(config), name);
    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }

    // Update profiles.json
    profilesData.profiles.splice(profileIndex, 1);
    writeProfilesJson(config, profilesData);

    // Commit and push
    console.log(`Deleting profile "${name}"...`);
    await commitAndPush(
      config,
      `delete: remove profile "${name}" from ${config.deviceId}`
    );

    console.log(`Profile "${name}" deleted.`);
  } finally {
    releaseLock();
  }
}

/**
 * Interactive yes/no confirmation.
 */
function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}
