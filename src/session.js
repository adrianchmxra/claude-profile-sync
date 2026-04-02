import fs from 'node:fs';
import path from 'node:path';
import { getClaudeDir } from './config.js';

/**
 * Check if a process with the given PID is currently running.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all active Claude Code sessions by reading ~/.claude/sessions/*.json
 * and verifying each PID is still alive.
 *
 * @returns {Array<{pid: number, sessionId: string, cwd: string, startedAt: number}>}
 */
export function getActiveClaudeSessions() {
  const sessionsDir = path.join(getClaudeDir(), 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  let files;
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  return files
    .map((f) => {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(sessionsDir, f), 'utf-8')
        );
        if (data.pid && isProcessAlive(data.pid)) {
          return data;
        }
        return null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Throws an error if any Claude Code sessions are currently active.
 * This prevents profile operations from corrupting a running session.
 */
export function requireNoActiveSessions() {
  const sessions = getActiveClaudeSessions();
  if (sessions.length === 0) return;

  const details = sessions
    .map((s) => `  - PID ${s.pid} in ${s.cwd}`)
    .join('\n');

  throw new Error(
    `Cannot modify ~/.claude while Claude Code is running.\n` +
      `Active sessions:\n${details}\n\n` +
      `Please close all Claude Code sessions first, then retry.`
  );
}
