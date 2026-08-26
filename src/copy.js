import fs from 'node:fs';
import path from 'node:path';
import {
  requireConfig,
  getProfilesDir,
  readProfilesJson,
  writeProfilesJson,
  validateProfileName,
  acquireLock,
} from './config.js';
import { pullRepo, commitAndPush } from './git.js';
import { copyProfile as copyProfileFiles, loadProfileIgnore } from './fs.js';

/**
 * Copy an existing profile to a new name, leaving the source untouched.
 *
 * This is a repo-only operation — ~/.claude is never read or written — so it
 * is safe to run while Claude Code is active. It is the graceful path for
 * restructuring: derive a new, better-named profile from an old one, verify
 * it, and only then delete the original.
 *
 * The copy deliberately does NOT inherit the source's `.device-id` marker:
 * `.device-id` is in ALWAYS_EXCLUDED, so the copy pass drops it and the new
 * profile starts unowned. The first device to push claims it, which is the
 * correct semantic for a fresh profile.
 *
 * The source's overlay flag IS inherited, so a copy of an overlay profile
 * stays an overlay profile (its stored layered region is a delta over base,
 * and remains a valid delta because base is unchanged).
 *
 * @param {string} srcName - The profile to copy from
 * @param {string} destName - The new profile name
 */
export async function copyProfileToNew(srcName, destName) {
  if (!srcName || !destName) {
    throw new Error('Usage: claude-profile copy <source-name> <new-name>');
  }
  validateProfileName(srcName);
  validateProfileName(destName);

  if (srcName === destName) {
    throw new Error('Source and destination profile names are identical.');
  }

  const config = requireConfig();

  const releaseLock = acquireLock('copy');
  try {
    console.log('Pulling latest from remote...');
    await pullRepo(config);

    const profilesData = readProfilesJson(config);
    const srcEntry = profilesData.profiles.find((p) => p.name === srcName);
    if (!srcEntry) {
      throw new Error(`Profile "${srcName}" not found.`);
    }
    if (profilesData.profiles.some((p) => p.name === destName)) {
      throw new Error(`Profile "${destName}" already exists.`);
    }

    const profilesDir = getProfilesDir(config);
    const srcDir = path.join(profilesDir, srcName);
    const destDir = path.join(profilesDir, destName);

    if (fs.existsSync(destDir)) {
      throw new Error(
        `A directory for "${destName}" already exists in the repo. ` +
          'Resolve it manually before copying.'
      );
    }
    fs.mkdirSync(destDir, { recursive: true });

    let copied = 0;
    if (fs.existsSync(srcDir)) {
      const ig = loadProfileIgnore(config);
      const result = copyProfileFiles(srcDir, destDir, ig, { additive: true });
      copied = result.copied;
    }
    console.log(`Copied ${copied} file(s) from "${srcName}" to "${destName}".`);

    const now = new Date().toISOString();
    const entry = {
      name: destName,
      createdAt: now,
      lastPushedAt: now,
    };
    if (srcEntry.overlay === true) entry.overlay = true;
    profilesData.profiles.push(entry);
    writeProfilesJson(config, profilesData);

    console.log('Pushing new profile to remote...');
    await commitAndPush(
      config,
      `copy: profile "${srcName}" -> "${destName}" from ${config.deviceId}`
    );

    console.log(
      `Profile "${destName}" created as a copy of "${srcName}"` +
        `${entry.overlay ? ' (overlay mode)' : ' (full snapshot)'}.`
    );
    console.log(`Use "claude-profile switch ${destName}" to activate it.`);
  } finally {
    releaseLock();
  }
}
