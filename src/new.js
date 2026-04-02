import fs from 'node:fs';
import path from 'node:path';
import {
  requireConfig,
  getProfilesDir,
  readProfilesJson,
  writeProfilesJson,
  getClaudeDir,
  validateProfileName,
} from './config.js';
import { pullRepo, commitAndPush } from './git.js';
import { copyProfile, loadProfileIgnore } from './fs.js';

/**
 * Create a new profile. Copies current ~/.claude as the starting point.
 *
 * @param {string} name - The profile name
 */
export async function newProfile(name) {
  if (!name) {
    throw new Error('Usage: claude-profile new <name>');
  }

  // Validate name: alphanumeric, spaces, dashes, underscores (no path traversal)
  validateProfileName(name);

  const config = requireConfig();

  // Pull latest
  console.log('Pulling latest from remote...');
  await pullRepo(config);

  // Check for duplicates
  const profilesData = readProfilesJson(config);
  if (profilesData.profiles.some((p) => p.name === name)) {
    throw new Error(`Profile "${name}" already exists.`);
  }

  // Create profile directory
  const profileDir = path.join(getProfilesDir(config), name);
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  // Copy current ~/.claude as starting point
  const claudeDir = getClaudeDir();
  if (fs.existsSync(claudeDir)) {
    console.log(`Copying current ~/.claude to new profile "${name}"...`);
    const ig = loadProfileIgnore(config);
    const count = copyProfile(claudeDir, profileDir, ig);
    console.log(`Copied ${count} files.`);
  }

  // Update profiles.json
  profilesData.profiles.push({
    name,
    createdAt: new Date().toISOString(),
    lastPushedAt: new Date().toISOString(),
  });
  writeProfilesJson(config, profilesData);

  // Commit and push
  console.log('Pushing new profile to remote...');
  await commitAndPush(config, `new: create profile "${name}" from ${config.deviceId}`);

  console.log(`Profile "${name}" created successfully.`);
  console.log(`Use "claude-profile switch ${name}" to activate it.`);
}
