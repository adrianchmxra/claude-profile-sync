import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { getClonePath } from './config.js';

/**
 * Inject a GitHub PAT into an HTTPS repo URL for authentication.
 * Converts: https://github.com/user/repo
 *       to: https://<token>@github.com/user/repo.git
 */
function authedUrl(repoUrl, token) {
  const url = new URL(repoUrl.endsWith('.git') ? repoUrl : repoUrl + '.git');
  url.username = token;
  url.password = '';
  return url.toString();
}

/**
 * Get a simple-git instance pointed at the clone directory.
 */
export function getGit(config) {
  const clonePath = getClonePath(config);
  return simpleGit(clonePath);
}

/**
 * Clone the sync repo into the local clone path.
 * If the directory already exists with a .git folder, skip cloning.
 */
export async function cloneRepo(config) {
  const clonePath = getClonePath(config);
  const gitDir = path.join(clonePath, '.git');

  if (fs.existsSync(gitDir)) {
    // Already cloned — just pull latest
    const git = simpleGit(clonePath);
    await git.pull().catch(() => {
      // Ignore pull errors on initial setup (empty repo)
    });
    return;
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(clonePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const url = authedUrl(config.repoUrl, config.token);
  try {
    await simpleGit().clone(url, clonePath);
  } catch (err) {
    // If the remote repo is empty, clone will fail.
    // Initialize locally and set remote instead.
    if (
      err.message.includes('empty') ||
      err.message.includes('appears to be an empty repository')
    ) {
      fs.mkdirSync(clonePath, { recursive: true });
      const git = simpleGit(clonePath);
      await git.init();
      await git.addRemote('origin', url);
      // Create initial branch
      await git.checkoutLocalBranch('main');
    } else {
      throw new Error(`Failed to clone repo: ${friendlyError(err, config)}`);
    }
  }
}

/**
 * Pull latest changes from remote. Returns true if pull succeeded.
 */
export async function pullRepo(config) {
  const git = getGit(config);
  try {
    await git.pull('origin', 'main');
    return true;
  } catch (err) {
    // If there's no upstream yet (first push hasn't happened), that's OK
    if (
      err.message.includes("couldn't find remote ref") ||
      err.message.includes('no tracking information')
    ) {
      return true;
    }
    throw new Error(`Failed to pull: ${friendlyError(err, config)}`);
  }
}

/**
 * Stage all changes, commit with message, and push to remote.
 * Returns true on success. Throws on non-fast-forward or network errors.
 */
export async function commitAndPush(config, message) {
  const git = getGit(config);

  await git.add('-A');

  // Check if there's anything to commit
  const status = await git.status();
  if (status.isClean()) {
    // Nothing to commit — still try to push in case there are unpushed commits
    try {
      await git.push('origin', 'main', ['--set-upstream']);
    } catch {
      // Ignore — might be nothing to push either
    }
    return true;
  }

  await git.commit(message);

  try {
    await git.push('origin', 'main', ['--set-upstream']);
  } catch (err) {
    const msg = err.message || '';
    if (
      msg.includes('non-fast-forward') ||
      msg.includes('fetch first') ||
      msg.includes('rejected')
    ) {
      throw new Error(
        'Push rejected: remote has changes not present locally.\n' +
          'Run "claude-profile pull" first, or use --force to overwrite.'
      );
    }
    throw new Error(`Push failed: ${friendlyError(err, config)}`);
  }

  return true;
}

/**
 * Force-push to remote (overwrites remote history).
 */
export async function forcePush(config, message) {
  const git = getGit(config);
  await git.add('-A');
  const status = await git.status();
  if (!status.isClean()) {
    await git.commit(message);
  }
  await git.push('origin', 'main', ['--set-upstream', '--force']);
  return true;
}

/**
 * Get the git status summary (for the status command).
 */
export async function getRepoStatus(config) {
  const git = getGit(config);
  try {
    const status = await git.status();
    const log = await git.log({ maxCount: 1 }).catch(() => null);
    return {
      clean: status.isClean(),
      staged: status.staged.length,
      modified: status.modified.length,
      lastCommit: log?.latest
        ? {
            message: log.latest.message,
            date: log.latest.date,
            hash: log.latest.hash?.slice(0, 7),
          }
        : null,
    };
  } catch {
    return { clean: true, staged: 0, modified: 0, lastCommit: null };
  }
}

/**
 * Strip tokens from error messages to prevent credential leakage.
 * Replaces any occurrence of the token in URLs with '***'.
 */
function sanitizeError(message, config) {
  if (!message) return message;
  if (!config?.token) return message;
  // Replace the token wherever it appears (URL-encoded or plain)
  const escaped = config.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return message.replace(new RegExp(escaped, 'g'), '***');
}

/**
 * Convert git errors into human-readable messages.
 */
function friendlyError(err, config) {
  let msg = err.message || String(err);
  msg = sanitizeError(msg, config);
  if (msg.includes('Authentication failed') || msg.includes('401')) {
    return 'Authentication failed. Check your GitHub PAT.';
  }
  if (msg.includes('not found') || msg.includes('404')) {
    return 'Repository not found. Check the repo URL and your access permissions.';
  }
  if (msg.includes('ENOTFOUND') || msg.includes('ENETUNREACH')) {
    return 'Network error. Check your internet connection.';
  }
  // Return first line only to avoid dumping stack traces
  return msg.split('\n')[0];
}
