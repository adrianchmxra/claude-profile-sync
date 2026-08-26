import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'claude-profile.js');

/**
 * Minimal sandbox: fake HOME with a seeded ~/.claude, a bare git repo as the
 * "remote", and a clone wired up as the data repo. `activeProfile` is left
 * empty, which is the state this regression is about.
 */
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-noactive-'));
  const home = path.join(root, 'home');
  const claudeDir = path.join(home, '.claude');
  const cpDir = path.join(home, '.claude-profile');
  const clonePath = path.join(cpDir, 'repo');
  const bareRemote = path.join(root, 'remote.git');

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(cpDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'CLAUDE from device\n');
  fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'agents', 'core.md'), 'core agent\n');
  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), '{"secret":"keep"}\n');

  execFileSync('git', ['init', '--bare', '-b', 'main', bareRemote], { stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', clonePath], { stdio: 'pipe' });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Sandbox',
    GIT_AUTHOR_EMAIL: 'sandbox@example.com',
    GIT_COMMITTER_NAME: 'Sandbox',
    GIT_COMMITTER_EMAIL: 'sandbox@example.com',
  };
  const git = (args) =>
    execFileSync('git', ['-C', clonePath, ...args], { stdio: 'pipe', env: gitEnv });
  git(['config', 'user.name', 'Sandbox']);
  git(['config', 'user.email', 'sandbox@example.com']);
  const remoteUrl = 'file://' + bareRemote.replace(/\\/g, '/');
  git(['remote', 'add', 'origin', remoteUrl]);
  fs.writeFileSync(
    path.join(clonePath, 'profiles.json'),
    JSON.stringify({ version: 1, profiles: [] }, null, 2) + '\n'
  );
  git(['add', '-A']);
  git(['commit', '-m', 'init data repo']);
  git(['push', '-u', 'origin', 'main']);

  fs.writeFileSync(
    path.join(cpDir, 'config.json'),
    JSON.stringify(
      { repoUrl: remoteUrl, deviceId: 'sandbox-device', activeProfile: '', clonePath },
      null,
      2
    ) + '\n'
  );

  const env = {
    ...process.env,
    CLAUDE_PROFILE_HOME: home,
    GH_TOKEN: 'sandbox-dummy-token',
    GIT_AUTHOR_NAME: 'Sandbox',
    GIT_AUTHOR_EMAIL: 'sandbox@example.com',
    GIT_COMMITTER_NAME: 'Sandbox',
    GIT_COMMITTER_EMAIL: 'sandbox@example.com',
  };

  return {
    claudeDir,
    cpDir,
    clonePath,
    env,
    profilesDir: path.join(clonePath, 'profiles'),
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function runCli(env, args) {
  try {
    const out = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout?.toString() ?? '', err: e.stderr?.toString() ?? '' };
  }
}

const exists = (...p) => fs.existsSync(path.join(...p));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf-8');

test('switch: with no active profile, does not snapshot over profiles/', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const cli = (...args) => {
    const r = runCli(sb.env, args);
    assert.equal(r.code, 0, `CLI failed: claude-profile ${args.join(' ')}\n${r.err}`);
    return r;
  };

  cli('new', 'Alpha', '--full');
  cli('new', 'Beta', '--full');
  assert.equal(
    JSON.parse(read(sb.cpDir, 'config.json')).activeProfile,
    '',
    'precondition: no active profile yet'
  );

  // path.join(profilesDir, '') resolves to profiles/ ITSELF. Treating that as
  // the "current profile" and snapshotting into it true-syncs ~/.claude over
  // the profiles directory: every stored profile is deleted, the local files
  // are dumped into profiles/ root, and the result is pushed to the remote.
  const out = cli('switch', 'Alpha').out;
  assert.doesNotMatch(out, /Saving local changes to ""/, 'must not snapshot an empty profile name');

  assert.ok(exists(sb.profilesDir, 'Alpha', 'agents', 'core.md'), 'Alpha survived');
  assert.ok(exists(sb.profilesDir, 'Beta', 'agents', 'core.md'), 'Beta survived');
  assert.ok(!exists(sb.profilesDir, 'CLAUDE.md'), 'no snapshot dumped into profiles/');
  assert.ok(!exists(sb.profilesDir, 'agents'), 'no snapshot dumped into profiles/');
  assert.ok(!exists(sb.profilesDir, '.device-id'), 'profiles/ not stamped as a profile');

  // The target still lands in ~/.claude rather than being wiped.
  assert.equal(read(sb.claudeDir, 'agents', 'core.md'), 'core agent\n');
  assert.equal(read(sb.claudeDir, 'CLAUDE.md'), 'CLAUDE from device\n');
  assert.equal(read(sb.claudeDir, '.credentials.json'), '{"secret":"keep"}\n');
});
