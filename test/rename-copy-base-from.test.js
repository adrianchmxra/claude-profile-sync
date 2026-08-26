import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'claude-profile.js');

/**
 * Self-contained sandbox: fake HOME with a seeded ~/.claude, a bare git repo
 * as the "remote", and a clone wired up as the data repo. Mirrors the harness
 * used by base-overlay.test.js.
 */
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-rc-'));
  const home = path.join(root, 'home');
  const claudeDir = path.join(home, '.claude');
  const cpDir = path.join(home, '.claude-profile');
  const clonePath = path.join(cpDir, 'repo');
  const bareRemote = path.join(root, 'remote.git');

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(cpDir, { recursive: true });

  // Layered seed
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'CLAUDE from device\n');
  fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'agents', 'core.md'), 'core agent\n');
  fs.writeFileSync(path.join(claudeDir, 'agents', 'reviewer.md'), 'reviewer agent\n');
  fs.mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'commands', 'ship.md'), 'ship command\n');
  // Non-layered seed
  fs.mkdirSync(path.join(claudeDir, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'knowledge', 'k.md'), 'knowledge k\n');
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
    root,
    home,
    claudeDir,
    cpDir,
    clonePath,
    env,
    profilesDir: path.join(clonePath, 'profiles'),
    baseDir: path.join(clonePath, 'base'),
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
    return {
      code: e.status ?? 1,
      out: e.stdout?.toString() ?? '',
      err: e.stderr?.toString() ?? '',
    };
  }
}

function makeRunners(sb) {
  const ok = (...args) => {
    const r = runCli(sb.env, args);
    assert.equal(r.code, 0, `expected success: claude-profile ${args.join(' ')}\n${r.err}`);
    return r;
  };
  const fail = (...args) => {
    const r = runCli(sb.env, args);
    assert.notEqual(r.code, 0, `expected failure: claude-profile ${args.join(' ')}\n${r.out}`);
    return r;
  };
  return { ok, fail };
}

const exists = (...p) => fs.existsSync(path.join(...p));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf-8');
const profilesJson = (sb) =>
  JSON.parse(read(sb.clonePath, 'profiles.json'));
const entryFor = (sb, name) => profilesJson(sb).profiles.find((p) => p.name === name);

/** Strip the layered region from ~/.claude to simulate a fresh device. */
function stripLayered(claudeDir) {
  fs.rmSync(path.join(claudeDir, 'CLAUDE.md'), { force: true });
  fs.rmSync(path.join(claudeDir, 'agents'), { recursive: true, force: true });
  fs.rmSync(path.join(claudeDir, 'commands'), { recursive: true, force: true });
}

/** Plant a sessions/*.json whose PID is this live test process. */
function plantLiveSession(claudeDir) {
  const dir = path.join(claudeDir, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'live.json'),
    JSON.stringify({ pid: process.pid, sessionId: 'live', cwd: '/tmp/fake', startedAt: 1 })
  );
}

// ---------------------------------------------------------------------------
// base add --from <profile>
// ---------------------------------------------------------------------------

test('base add --from: sources a file from a stored profile when ~/.claude is bare', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok } = makeRunners(sb);

  ok('new', 'Alpha', '--full');
  // Simulate a fresh machine: no layered files locally at all.
  stripLayered(sb.claudeDir);
  assert.ok(!exists(sb.claudeDir, 'agents'), 'precondition: ~/.claude has no agents/');

  ok('base', 'add', '--from', 'Alpha', 'agents/core.md');

  assert.ok(exists(sb.baseDir, 'agents', 'core.md'), 'file landed in base/');
  assert.equal(read(sb.baseDir, 'agents', 'core.md'), 'core agent\n');
  // Sourcing from a profile must not resurrect anything in ~/.claude.
  assert.ok(!exists(sb.claudeDir, 'agents'), '~/.claude left untouched');

  const shown = ok('base', 'show').out;
  assert.match(shown, /agents\/core\.md/);
});

test('base add --from: a directory pulls every layered file beneath it', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok } = makeRunners(sb);

  ok('new', 'Alpha', '--full');
  stripLayered(sb.claudeDir);

  ok('base', 'add', '--from', 'Alpha', 'agents');

  assert.ok(exists(sb.baseDir, 'agents', 'core.md'));
  assert.ok(exists(sb.baseDir, 'agents', 'reviewer.md'));
  assert.equal(read(sb.baseDir, 'agents', 'reviewer.md'), 'reviewer agent\n');
});

test('base add --from: non-layered path is rejected even from a profile', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok, fail } = makeRunners(sb);

  ok('new', 'Alpha', '--full');
  const r = fail('base', 'add', '--from', 'Alpha', 'knowledge/k.md');
  assert.match(r.err, /not in the layered region/);
  assert.ok(!exists(sb.baseDir, 'knowledge'), 'nothing leaked into base/');
});

test('base add --from: unknown profile and missing path produce clear errors', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok, fail } = makeRunners(sb);

  ok('new', 'Alpha', '--full');

  const unknown = fail('base', 'add', '--from', 'Nope', 'agents/core.md');
  assert.match(unknown.err, /Profile "Nope" not found/);

  const missing = fail('base', 'add', '--from', 'Alpha', 'agents/ghost.md');
  assert.match(missing.err, /does not exist in profile "Alpha"/);
});

test('base add: without --from it still reads ~/.claude (regression)', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok, fail } = makeRunners(sb);

  ok('base', 'add', 'agents/core.md');
  assert.equal(read(sb.baseDir, 'agents', 'core.md'), 'core agent\n');

  stripLayered(sb.claudeDir);
  const r = fail('base', 'add', 'commands/ship.md');
  assert.match(r.err, /does not exist in ~\/\.claude/);
});

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

test('rename: moves the directory, relabels the entry, preserves contents', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok } = makeRunners(sb);

  ok('new', 'Home PC', '--full');
  assert.ok(exists(sb.profilesDir, 'Home PC'));

  ok('rename', 'Home PC', 'product');

  assert.ok(!exists(sb.profilesDir, 'Home PC'), 'old dir gone');
  assert.ok(exists(sb.profilesDir, 'product'), 'new dir present');
  assert.equal(read(sb.profilesDir, 'product', 'agents', 'core.md'), 'core agent\n');
  assert.equal(read(sb.profilesDir, 'product', 'knowledge', 'k.md'), 'knowledge k\n');

  assert.ok(entryFor(sb, 'product'), 'profiles.json has the new name');
  assert.ok(!entryFor(sb, 'Home PC'), 'profiles.json dropped the old name');
});

test('rename: preserves the overlay flag and createdAt', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok } = makeRunners(sb);

  ok('new', 'Gamma'); // overlay by default
  const before = entryFor(sb, 'Gamma');
  assert.equal(before.overlay, true, 'precondition: overlay profile');

  ok('rename', 'Gamma', 'engineering');

  const after = entryFor(sb, 'engineering');
  assert.equal(after.overlay, true, 'overlay flag survives rename');
  assert.equal(after.createdAt, before.createdAt, 'createdAt is not reset');
});

test('rename: repoints this device active profile', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok } = makeRunners(sb);

  ok('new', 'Alpha', '--full');
  ok('switch', 'Alpha');
  assert.equal(
    JSON.parse(read(sb.cpDir, 'config.json')).activeProfile,
    'Alpha',
    'precondition: Alpha is active'
  );

  ok('rename', 'Alpha', 'renamed');

  assert.equal(
    JSON.parse(read(sb.cpDir, 'config.json')).activeProfile,
    'renamed',
    'active pointer followed the rename'
  );
  // A stale pointer would make list/status lie; confirm list agrees.
  assert.match(ok('list').out, /renamed \(active\)/);
});

test('rename: rejects unknown source, existing target, and no-op rename', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok, fail } = makeRunners(sb);

  ok('new', 'Alpha', '--full');
  ok('new', 'Beta', '--full');

  assert.match(fail('rename', 'Ghost', 'x').err, /Profile "Ghost" not found/);
  assert.match(fail('rename', 'Alpha', 'Beta').err, /Profile "Beta" already exists/);
  assert.match(fail('rename', 'Alpha', 'Alpha').err, /identical/);

  // Nothing should have moved.
  assert.ok(exists(sb.profilesDir, 'Alpha'));
  assert.ok(exists(sb.profilesDir, 'Beta'));
});

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

test('copy: duplicates a profile and leaves the source intact', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok } = makeRunners(sb);

  ok('new', 'Home PC', '--full');
  ok('copy', 'Home PC', 'product');

  assert.ok(exists(sb.profilesDir, 'Home PC'), 'source still present');
  assert.ok(exists(sb.profilesDir, 'product'), 'copy created');
  assert.equal(read(sb.profilesDir, 'product', 'agents', 'core.md'), 'core agent\n');
  assert.equal(read(sb.profilesDir, 'product', 'CLAUDE.md'), 'CLAUDE from device\n');
  assert.equal(
    read(sb.profilesDir, 'Home PC', 'agents', 'core.md'),
    'core agent\n',
    'source contents unchanged'
  );

  assert.ok(entryFor(sb, 'Home PC'));
  assert.ok(entryFor(sb, 'product'));
});

test('copy: inherits the overlay flag from the source', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok } = makeRunners(sb);

  ok('new', 'Gamma');           // overlay
  ok('new', 'Full', '--full');  // legacy

  ok('copy', 'Gamma', 'gamma-copy');
  ok('copy', 'Full', 'full-copy');

  assert.equal(entryFor(sb, 'gamma-copy').overlay, true, 'overlay inherited');
  assert.equal(
    entryFor(sb, 'full-copy').overlay,
    undefined,
    'full snapshot stays a full snapshot'
  );
});

test('copy: does not inherit the device-ownership marker', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok } = makeRunners(sb);

  ok('new', 'Alpha', '--full');
  ok('switch', 'Alpha');
  // Give push something to do — a no-op push does not stamp ownership.
  fs.writeFileSync(path.join(sb.claudeDir, 'agents', 'extra.md'), 'extra\n');
  ok('push');
  assert.ok(
    exists(sb.profilesDir, 'Alpha', '.device-id'),
    'precondition: push stamped ownership'
  );

  ok('copy', 'Alpha', 'derived');

  assert.ok(
    !exists(sb.profilesDir, 'derived', '.device-id'),
    'copy starts unowned so any device can claim it'
  );
  assert.ok(exists(sb.profilesDir, 'Alpha', '.device-id'), 'source keeps its marker');
});

test('copy: rejects unknown source, existing target, and self-copy', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok, fail } = makeRunners(sb);

  ok('new', 'Alpha', '--full');
  ok('new', 'Beta', '--full');

  assert.match(fail('copy', 'Ghost', 'x').err, /Profile "Ghost" not found/);
  assert.match(fail('copy', 'Alpha', 'Beta').err, /Profile "Beta" already exists/);
  assert.match(fail('copy', 'Alpha', 'Alpha').err, /identical/);
  assert.ok(!exists(sb.profilesDir, 'x'), 'no partial directory left behind');
});

// ---------------------------------------------------------------------------
// The property that makes these usable mid-session
// ---------------------------------------------------------------------------

test('rename/copy/base add --from work with Claude Code running; base pull does not', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok, fail } = makeRunners(sb);

  ok('new', 'Alpha', '--full');
  plantLiveSession(sb.claudeDir);

  // Sanity: the guard really is armed in this sandbox.
  const blocked = fail('base', 'pull');
  assert.match(blocked.err, /while Claude Code is running/);

  // Repo-only operations are unaffected.
  ok('copy', 'Alpha', 'derived');
  ok('rename', 'derived', 'product');
  ok('base', 'add', '--from', 'product', 'agents/core.md');

  assert.ok(exists(sb.profilesDir, 'product'));
  assert.ok(exists(sb.baseDir, 'agents', 'core.md'));
});

test('end-to-end: derive a config profile from a device profile, then retire the old one', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const { ok, fail } = makeRunners(sb);

  // A legacy device-named profile, as in a real repo.
  ok('new', 'Home PC', '--full');
  ok('switch', 'Home PC');

  // Curate base from it, then derive a config-named successor.
  ok('base', 'add', '--from', 'Home PC', 'agents/core.md');
  ok('copy', 'Home PC', 'product');
  ok('migrate', 'product');

  // Move onto the successor before retiring the original.
  ok('switch', 'product');
  assert.equal(entryFor(sb, 'product').overlay, true);

  // The active profile cannot be deleted, but the retired one can.
  assert.match(fail('delete', 'product', '--yes').err, /Cannot delete the active profile/);
  ok('delete', 'Home PC', '--yes');

  assert.ok(!entryFor(sb, 'Home PC'), 'device-named profile retired');
  assert.ok(!exists(sb.profilesDir, 'Home PC'), 'its directory is gone');

  // base + overlay still reconstruct a working layered region.
  assert.equal(read(sb.claudeDir, 'agents', 'core.md'), 'core agent\n');
  assert.equal(read(sb.claudeDir, 'CLAUDE.md'), 'CLAUDE from device\n');
  // Non-layered data survived the whole restructure.
  assert.equal(read(sb.claudeDir, '.credentials.json'), '{"secret":"keep"}\n');
});
