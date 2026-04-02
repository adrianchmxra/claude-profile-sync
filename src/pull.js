import path from 'node:path';
import fs from 'node:fs';
import {
  requireConfig,
  getClaudeDir,
  getProfilesDir,
} from './config.js';
import { pullRepo } from './git.js';
import { copyProfile, diffProfile, loadProfileIgnore } from './fs.js';
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

  // Block if Claude Code is running to prevent config corruption
  requireNoActiveSessions();

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
    }
    return;
  }

  if (!diff.changed) {
    console.log(`~/.claude is already in sync with profile "${profileName}".`);
    return;
  }

  // Copy profile directory to ~/.claude (additive — no deletion)
  console.log(`Restoring profile "${profileName}" to ~/.claude... (${diff.summary})`);
  const count = copyProfile(profileDir, claudeDir, ig);
  console.log(`Copied ${count} files.`);
  console.log(`Profile "${profileName}" restored successfully.`);
}
