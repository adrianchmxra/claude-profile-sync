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
import { copyProfile, loadProfileIgnore, splitLayered, getSyncableFiles } from './fs.js';

/**
 * Create a new profile from current ~/.claude.
 *
 * By default new profiles are OVERLAY profiles ({ overlay: true }): they start
 * with a non-layered snapshot of ~/.claude and an EMPTY layered overlay, so the
 * effective layered environment after switching to a fresh profile is pure
 * base. Pass `{ full: true }` to create a legacy full-snapshot profile instead
 * (stores the entire ~/.claude, layered region included, and no overlay flag).
 *
 * @param {string} name - The profile name
 * @param {object} [options] - { full: boolean }
 */
export async function newProfile(name, options = {}) {
  if (!name) {
    throw new Error('Usage: claude-profile new <name>');
  }

  // Validate name: alphanumeric, spaces, dashes, underscores (no path traversal)
  validateProfileName(name);

  const overlay = !options.full;

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
    const ig = loadProfileIgnore(config);
    if (overlay) {
      // Overlay profile: store only the NON-layered snapshot; the layered
      // overlay starts empty so the profile resolves to pure base until the
      // user pushes layered changes into it.
      console.log(`Copying non-layered ~/.claude to new overlay profile "${name}"...`);
      const syncable = getSyncableFiles(claudeDir, ig);
      const { nonLayered } = splitLayered(syncable);
      const result = copyProfile(claudeDir, profileDir, ig, {
        additive: true,
        files: nonLayered,
      });
      console.log(`Copied ${result.copied} non-layered files (empty overlay).`);
    } else {
      // Legacy full-snapshot profile.
      console.log(`Copying current ~/.claude to new profile "${name}"...`);
      const result = copyProfile(claudeDir, profileDir, ig);
      console.log(`Copied ${result.copied} files.`);
    }
  }

  // Update profiles.json
  const entry = {
    name,
    createdAt: new Date().toISOString(),
    lastPushedAt: new Date().toISOString(),
  };
  if (overlay) entry.overlay = true;
  profilesData.profiles.push(entry);
  writeProfilesJson(config, profilesData);

  // Commit and push
  console.log('Pushing new profile to remote...');
  await commitAndPush(config, `new: create profile "${name}" from ${config.deviceId}`);

  console.log(
    `Profile "${name}" created successfully${overlay ? ' (overlay mode)' : ' (full snapshot)'}.`
  );
  console.log(`Use "claude-profile switch ${name}" to activate it.`);
}
