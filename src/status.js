import path from 'node:path';
import fs from 'node:fs';
import {
  requireConfig,
  getClaudeDir,
  getProfilesDir,
  getClonePath,
  readProfilesJson,
} from './config.js';
import { getRepoStatus } from './git.js';
import { diffProfile, loadProfileIgnore } from './fs.js';

/**
 * Show sync status: active profile, local changes, repo state.
 */
export async function status() {
  const config = requireConfig();
  const profileName = config.activeProfile;

  console.log('claude-profile status');
  console.log('=====================');
  console.log('');
  console.log(`  Device:         ${config.deviceId}`);
  console.log(`  Active profile: ${profileName}`);
  console.log(`  Repo:           ${config.repoUrl}`);
  console.log(`  Local clone:    ${getClonePath(config)}`);
  console.log('');

  // Check if profile directory exists
  const profileDir = path.join(getProfilesDir(config), profileName);
  const claudeDir = getClaudeDir();

  if (!fs.existsSync(profileDir)) {
    console.log('  Profile directory not found in sync repo.');
    console.log('  Run "claude-profile push" to create it.');
    return;
  }

  // Diff local ~/.claude against the profile in the repo
  const ig = loadProfileIgnore(config);
  const diff = diffProfile(claudeDir, profileDir, ig);

  if (diff.changed) {
    console.log(`  Local changes:  ${diff.summary}`);
    if (diff.added.length > 0) {
      console.log(`    New files (${diff.added.length}):`);
      for (const f of diff.added.slice(0, 10)) console.log(`      + ${f}`);
      if (diff.added.length > 10)
        console.log(`      ... and ${diff.added.length - 10} more`);
    }
    if (diff.modified.length > 0) {
      console.log(`    Modified files (${diff.modified.length}):`);
      for (const f of diff.modified.slice(0, 10)) console.log(`      ~ ${f}`);
      if (diff.modified.length > 10)
        console.log(`      ... and ${diff.modified.length - 10} more`);
    }
  } else {
    console.log('  Local changes:  none (in sync)');
  }

  // Git repo status
  const repoStatus = await getRepoStatus(config);
  console.log('');
  if (repoStatus.lastCommit) {
    console.log(
      `  Last commit:    ${repoStatus.lastCommit.hash} — ${repoStatus.lastCommit.message}`
    );
    console.log(
      `  Committed at:   ${repoStatus.lastCommit.date}`
    );
  }

  // Profile count
  const profilesData = readProfilesJson(config);
  console.log(`  Total profiles: ${profilesData.profiles.length}`);
}
