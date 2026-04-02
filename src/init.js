import readline from 'node:readline';
import { execSync, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  getConfig,
  saveConfig,
  getClonePath,
  getProfilesDir,
  writeProfilesJson,
  readProfilesJson,
  getClaudeDir,
  validateProfileName,
} from './config.js';
import { cloneRepo, commitAndPush } from './git.js';
import { copyProfile, loadProfileIgnore } from './fs.js';

/**
 * Interactive prompt helper.
 */
function ask(rl, question, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Check if gh CLI is installed and authenticated.
 * Returns the auth token if available, null otherwise.
 */
function getGhToken() {
  try {
    const token = execSync('gh auth token', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Get the authenticated GitHub username via gh CLI.
 */
function getGhUsername() {
  try {
    return execSync('gh api user --jq .login', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Create a private GitHub repo via gh CLI. Returns the HTTPS URL.
 */
function createRepoWithGh(repoName) {
  try {
    const url = execFileSync('gh', ['repo', 'create', repoName, '--private', '--confirm'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return url;
  } catch (err) {
    const msg = err.stderr || err.message || '';
    if (msg.includes('already exists')) {
      const username = getGhUsername();
      return `https://github.com/${username}/${repoName}`;
    }
    throw new Error(`Failed to create repo: ${msg.split('\n')[0]}`);
  }
}

/**
 * Initialize claude-profile: interactive setup wizard.
 */
export async function init() {
  const existing = getConfig();
  if (existing && existing.repoUrl) {
    console.log('claude-profile is already initialized.');
    console.log(`  Repo: ${existing.repoUrl}`);
    console.log(`  Profile: ${existing.activeProfile}`);
    console.log(`  Device: ${existing.deviceId}`);
    console.log('\nTo reconfigure, delete ~/.claude-profile/config.json and run init again.');
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('');
    console.log('claude-profile-sync setup');
    console.log('========================');
    console.log('');
    console.log(
      'This tool syncs your ~/.claude directory across devices via a private GitHub repo.'
    );
    console.log('');

    // Detect gh CLI
    const ghToken = getGhToken();
    let repoUrl;
    let token;

    if (ghToken) {
      console.log('GitHub CLI detected and authenticated.');
      const authMethod = await ask(
        rl,
        'Auth method: (1) Use gh CLI  (2) Enter PAT manually',
        '1'
      );

      if (authMethod === '1') {
        token = ghToken;
        const username = getGhUsername();
        console.log(`Logged in as: ${username}`);
        console.log('');

        const repoChoice = await ask(
          rl,
          'Repo: (1) Create new "claude-profiles" repo  (2) Use existing repo URL',
          '1'
        );

        if (repoChoice === '1') {
          const repoName = await ask(rl, 'Repo name', 'claude-profiles');
          console.log(`Creating private repo ${username}/${repoName}...`);
          repoUrl = createRepoWithGh(repoName);
          console.log(`Repo ready: ${repoUrl}`);
        } else {
          repoUrl = await ask(rl, 'GitHub repo URL', '');
          if (!repoUrl) {
            console.error('Error: Repo URL is required.');
            return;
          }
        }
      } else {
        repoUrl = await ask(rl, 'GitHub repo URL (e.g. https://github.com/you/claude-profiles)', '');
        if (!repoUrl) {
          console.error('Error: Repo URL is required.');
          return;
        }
        token = await ask(rl, 'GitHub Personal Access Token (PAT)', '');
        if (!token) {
          console.error('Error: GitHub PAT is required.');
          return;
        }
      }
    } else {
      console.log(
        'Tip: Install the GitHub CLI (gh) to skip PAT setup. See https://cli.github.com'
      );
      console.log('');
      repoUrl = await ask(
        rl,
        'GitHub repo URL (e.g. https://github.com/you/claude-profiles)',
        ''
      );
      if (!repoUrl) {
        console.error('Error: Repo URL is required.');
        return;
      }
      token = await ask(rl, 'GitHub Personal Access Token (PAT)', '');
      if (!token) {
        console.error('Error: GitHub PAT is required.');
        return;
      }
    }

    const defaultDevice = `${os.hostname()}-${process.platform}`;
    const deviceId = await ask(rl, 'Device name', defaultDevice);

    const defaultProfile = deviceId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const profileName = await ask(rl, 'Profile name for this device', defaultProfile);
    validateProfileName(profileName);

    rl.close();

    // Save config
    const config = {
      repoUrl,
      token,
      deviceId,
      activeProfile: profileName,
      clonePath: getClonePath({ clonePath: '' }),
    };
    saveConfig(config);
    console.log('\nConfig saved to ~/.claude-profile/config.json');

    // Clone or init repo
    console.log('Cloning sync repo...');
    await cloneRepo(config);
    console.log('Repo ready.');

    // Create profiles directory
    const profilesDir = getProfilesDir(config);
    const profileDir = path.join(profilesDir, profileName);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    // Copy current ~/.claude into the profile
    const claudeDir = getClaudeDir();
    if (fs.existsSync(claudeDir)) {
      console.log(`Copying current ~/.claude to profile "${profileName}"...`);
      const ig = loadProfileIgnore(config);
      const count = copyProfile(claudeDir, profileDir, ig);
      console.log(`Copied ${count} files.`);
    }

    // Create/update profiles.json
    const profilesData = readProfilesJson(config);
    const exists = profilesData.profiles.some((p) => p.name === profileName);
    if (!exists) {
      profilesData.profiles.push({
        name: profileName,
        createdAt: new Date().toISOString(),
        lastPushedAt: new Date().toISOString(),
      });
    }
    writeProfilesJson(config, profilesData);

    // Create default .profileignore if it doesn't exist
    const clonePath = getClonePath(config);
    const profileIgnorePath = path.join(clonePath, '.profileignore');
    if (!fs.existsSync(profileIgnorePath)) {
      fs.writeFileSync(
        profileIgnorePath,
        '# Add patterns here to exclude files from syncing\n# Uses .gitignore syntax\n',
        'utf-8'
      );
    }

    // Commit and push
    console.log('Pushing initial profile to remote...');
    try {
      await commitAndPush(
        config,
        `init: add profile "${profileName}" from ${deviceId}`
      );
      console.log('Pushed successfully.');
    } catch (err) {
      console.error(`Warning: Push failed: ${err.message}`);
      console.log('Your profile is saved locally. Run "claude-profile push" to retry.');
    }

    console.log('');
    console.log('Setup complete! Commands:');
    console.log('  claude-profile push       Save changes to remote');
    console.log('  claude-profile pull       Restore from remote');
    console.log('  claude-profile switch <n> Switch to a different profile');
    console.log('  claude-profile status     Show sync status');
    console.log('  claude-profile list       List all profiles');
  } finally {
    if (!rl.closed) rl.close();
  }
}
