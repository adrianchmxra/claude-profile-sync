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

/** Rewrite config.deviceId to simulate operating from a different machine. */
function actAsDevice(sb, deviceId) {
  const p = path.join(sb.cpDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
  cfg.deviceId = deviceId;
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}

function makeCli(sb) {
  return (...args) => {
    const r = runCli(sb.env, args);
    assert.equal(r.code, 0, `CLI failed: claude-profile ${args.join(' ')}\n${r.err}`);
    return r;
  };
}

test('push: a second device can push a profile the first device pushed', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const cli = makeCli(sb);

  cli('new', 'product', '--full');
  cli('switch', 'product');
  fs.writeFileSync(path.join(sb.claudeDir, 'agents', 'from-a.md'), 'written on A\n');
  cli('push');
  assert.equal(
    read(sb.profilesDir, 'product', '.device-id').trim(),
    'sandbox-device',
    'precondition: device A recorded as last writer'
  );

  // Same configuration, different machine — this is the normal case once
  // profiles describe configs rather than devices.
  actAsDevice(sb, 'laptop-b');
  fs.writeFileSync(path.join(sb.claudeDir, 'agents', 'from-b.md'), 'written on B\n');
  const out = cli('push').out;

  assert.match(out, /last pushed by device "sandbox-device"/, 'reports the previous writer');
  assert.ok(exists(sb.profilesDir, 'product', 'agents', 'from-b.md'), "B's change landed");
  assert.ok(exists(sb.profilesDir, 'product', 'agents', 'from-a.md'), "A's change preserved");
  assert.equal(
    read(sb.profilesDir, 'product', '.device-id').trim(),
    'laptop-b',
    'marker now records B as most recent writer'
  );
});

test('pull: a second device can pull a profile the first device pushed', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const cli = makeCli(sb);

  cli('new', 'product', '--full');
  cli('switch', 'product');
  fs.writeFileSync(path.join(sb.claudeDir, 'agents', 'from-a.md'), 'written on A\n');
  cli('push');

  actAsDevice(sb, 'laptop-b');
  fs.rmSync(path.join(sb.claudeDir, 'agents', 'from-a.md'));
  const out = cli('pull').out;

  assert.match(out, /last pushed by device "sandbox-device"/, 'reports the previous writer');
  assert.equal(
    read(sb.claudeDir, 'agents', 'from-a.md'),
    'written on A\n',
    'pull restored the file rather than refusing'
  );
});

test('switch: snapshots local work even when another device pushed last', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const cli = makeCli(sb);

  cli('new', 'product', '--full');
  cli('new', 'research', '--full');
  cli('switch', 'product');
  cli('push');

  // Another machine pushes product, becoming its recorded writer.
  actAsDevice(sb, 'desktop-a');
  fs.writeFileSync(path.join(sb.claudeDir, 'agents', 'from-a.md'), 'written on A\n');
  cli('push');

  // Back on this machine: make local changes, then switch away. The old
  // ownership check skipped the snapshot here and discarded this work.
  actAsDevice(sb, 'laptop-b');
  fs.writeFileSync(path.join(sb.claudeDir, 'agents', 'unsaved.md'), 'must not be lost\n');
  const out = cli('switch', 'research').out;

  assert.doesNotMatch(out, /Skipping snapshot/, 'did not skip the snapshot');
  assert.match(out, /Saving local changes to "product"/);
  assert.equal(
    read(sb.profilesDir, 'product', 'agents', 'unsaved.md'),
    'must not be lost\n',
    'local work was snapshotted into the profile before switching away'
  );
});

test('pull no longer takes a --force ownership bypass', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const cli = makeCli(sb);

  cli('new', 'product', '--full');
  cli('switch', 'product');

  const r = runCli(sb.env, ['pull', '--force']);
  assert.notEqual(r.code, 0, 'the flag is gone rather than silently ignored');
  assert.match(r.err, /unknown option/i);
});
