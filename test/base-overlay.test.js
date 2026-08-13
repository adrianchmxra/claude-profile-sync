import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isLayeredPath } from '../src/fs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'claude-profile.js');

/**
 * Build a self-contained sandbox:
 *   - a fake HOME with ~/.claude seeded (layered + non-layered files)
 *   - a bare git repo acting as the "remote"
 *   - a cloned working repo wired as the data repo, with config.json pointing
 *     at it via CLAUDE_PROFILE_HOME.
 *
 * Returns { home, env, cleanup, claudeDir }.
 */
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-sandbox-'));
  const home = path.join(root, 'home');
  const claudeDir = path.join(home, '.claude');
  const cpDir = path.join(home, '.claude-profile');
  const clonePath = path.join(cpDir, 'repo');
  const bareRemote = path.join(root, 'remote.git');

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(cpDir, { recursive: true });

  // --- Seed ~/.claude ---
  // Layered
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'BASE CLAUDE CONTENT\n');
  fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'agents', 'core.md'), 'core agent\n');
  fs.writeFileSync(
    path.join(claudeDir, 'agents', 'self-reviewing-implementer.md'),
    'self-reviewing-implementer BASE\n'
  );
  fs.mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'commands', 'x.md'), 'command x\n');
  // Non-layered
  fs.mkdirSync(path.join(claudeDir, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'knowledge', 'k.md'), 'knowledge k\n');
  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), '{"secret":"do-not-delete"}\n');

  // --- Bare remote ---
  execFileSync('git', ['init', '--bare', '-b', 'main', bareRemote], { stdio: 'pipe' });

  // --- Cloned working repo (the data repo) ---
  execFileSync('git', ['init', '-b', 'main', clonePath], { stdio: 'pipe' });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Sandbox',
    GIT_AUTHOR_EMAIL: 'sandbox@example.com',
    GIT_COMMITTER_NAME: 'Sandbox',
    GIT_COMMITTER_EMAIL: 'sandbox@example.com',
  };
  const git = (args) => execFileSync('git', ['-C', clonePath, ...args], { stdio: 'pipe', env: gitEnv });
  git(['config', 'user.name', 'Sandbox']);
  git(['config', 'user.email', 'sandbox@example.com']);
  // Use a file:// URL so authedUrl (which injects userinfo) is a harmless no-op
  // for the file scheme and git can push directly with no network/auth.
  const remoteUrl = 'file://' + bareRemote.replace(/\\/g, '/');
  git(['remote', 'add', 'origin', remoteUrl]);
  // Seed an initial commit so `main` exists on the remote.
  fs.writeFileSync(
    path.join(clonePath, 'profiles.json'),
    JSON.stringify({ version: 1, profiles: [] }, null, 2) + '\n'
  );
  git(['add', '-A']);
  git(['commit', '-m', 'init data repo']);
  git(['push', '-u', 'origin', 'main']);

  // --- config.json ---
  // repoUrl must be the bare remote; the code appends .git and injects the
  // (dummy) token via authedUrl — both no-ops for file://.
  const config = {
    repoUrl: remoteUrl,
    deviceId: 'sandbox-device',
    activeProfile: '',
    clonePath,
  };
  fs.writeFileSync(
    path.join(cpDir, 'config.json'),
    JSON.stringify(config, null, 2) + '\n'
  );

  const env = {
    ...process.env,
    CLAUDE_PROFILE_HOME: home,
    // Dummy token so getRuntimeToken() never shells out to `gh`.
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
    clonePath,
    env,
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

function exists(...p) {
  return fs.existsSync(path.join(...p));
}

function read(...p) {
  return fs.readFileSync(path.join(...p), 'utf-8');
}

test('isLayeredPath: only CLAUDE.md + agents/ + commands/ + skills/ are layered', () => {
  const cases = [
    ['CLAUDE.md', true],
    ['agents/foo.md', true],
    ['agents/sub/bar.md', true],
    ['commands/x.md', true],
    ['skills/s/SKILL.md', true],
    ['agents', true],
    ['CLAUDE.md.bak', false],
    ['agents-backup/foo.md', false],
    ['knowledge/k.md', false],
    ['.credentials.json', false],
    ['.mcp.json', false],
    ['history.jsonl', false],
    ['settings.json', false],
    ['agentsfoo.md', false],
    ['myagents/foo.md', false],
  ];
  for (const [p, want] of cases) {
    assert.equal(isLayeredPath(p), want, `isLayeredPath(${JSON.stringify(p)})`);
  }
});

test('overlay delta drops a layered file once it matches base again (re-push)', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const cli = (...args) => {
    const r = runCli(sb.env, args);
    assert.equal(r.code, 0, `CLI failed: claude-profile ${args.join(' ')}\n${r.err}`);
    return r;
  };
  const claudeDir = sb.claudeDir;
  const cfgPath = path.join(sb.home, '.claude-profile', 'config.json');

  // Base = CLAUDE.md (content "BASE CLAUDE CONTENT").
  cli('new', 'P');
  const cfg = JSON.parse(read(cfgPath));
  cfg.activeProfile = 'P';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  cli('base', 'add', 'CLAUDE.md');
  cli('switch', 'P'); // now on P, layered = base only

  // Diverge CLAUDE.md from base, push -> overlay must store it.
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'DIVERGED CONTENT\n');
  cli('push');
  const cloneP = path.join(sb.clonePath, 'profiles', 'P');
  assert.ok(exists(cloneP, 'CLAUDE.md'), 'overlay stores diverged CLAUDE.md');

  // Now restore it to exactly base content and re-push -> overlay must DROP it.
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'BASE CLAUDE CONTENT\n');
  cli('push');
  assert.ok(
    !exists(cloneP, 'CLAUDE.md'),
    'overlay must drop CLAUDE.md once it matches base again (pure delta)'
  );
});

test('base + swappable overlay: full DoD scenario', (t) => {
  const sb = makeSandbox();
  const log = [];
  const say = (m) => log.push(m);
  t.after(() => {
    // Emit the captured scenario log so it appears in test output.
    console.log('\n----- DoD scenario log -----');
    for (const line of log) console.log(line);
    console.log('----- end scenario log -----\n');
    sb.cleanup();
  });

  const cli = (...args) => {
    const r = runCli(sb.env, args);
    say(`$ claude-profile ${args.join(' ')}`);
    if (r.out.trim()) say(r.out.trim());
    if (r.err.trim()) say('[stderr] ' + r.err.trim());
    assert.equal(r.code, 0, `CLI failed: claude-profile ${args.join(' ')}\n${r.err}`);
    return r;
  };

  const claudeDir = sb.claudeDir;

  // --- Bootstrap: create the very first (default overlay) profile "seed" and
  //     activate it so there is an active profile to switch away from. ---
  cli('new', 'seed');
  // Activate it by editing config (no switch target yet). Simulate "init"
  // having set the active profile.
  const cfgPath = path.join(sb.home, '.claude-profile', 'config.json');
  const cfg = JSON.parse(read(cfgPath));
  cfg.activeProfile = 'seed';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

  // === Step 1: Seed base ===
  cli('base', 'add', 'CLAUDE.md');
  cli('base', 'add', 'agents/self-reviewing-implementer.md');
  const baseShow = cli('base', 'show');
  say('--- base show ---\n' + baseShow.out.trim());
  const cloneBase = path.join(sb.clonePath, 'base');
  assert.ok(exists(cloneBase, 'CLAUDE.md'), 'base/CLAUDE.md should exist');
  assert.ok(
    exists(cloneBase, 'agents', 'self-reviewing-implementer.md'),
    'base/agents/self-reviewing-implementer.md should exist'
  );
  // base must NOT contain non-base layered items or non-layered items.
  assert.ok(!exists(cloneBase, 'agents', 'core.md'), 'base must not contain agents/core.md');
  assert.ok(!exists(cloneBase, 'knowledge', 'k.md'), 'base must never contain non-layered files');
  say('ASSERT ok: base contains exactly the two curated files.');

  // === Step 2: Create profile A with overlay X, profile B with overlay Y ===
  // Profile A: add an extra skill agents/expX.md, push into A.
  cli('new', 'A');
  cli('switch', 'A'); // active is now A (overlay). Layered region rebuilt = base only.
  // After switching to A (empty overlay), layered region = base only.
  assert.ok(exists(claudeDir, 'CLAUDE.md'), 'A: CLAUDE.md (from base) present');
  assert.ok(
    exists(claudeDir, 'agents', 'self-reviewing-implementer.md'),
    'A: self-reviewing-implementer (from base) present'
  );
  assert.ok(!exists(claudeDir, 'agents', 'core.md'), 'A: agents/core.md not in base, should be gone');
  // Non-layered survived the clean rebuild.
  assert.ok(exists(claudeDir, 'knowledge', 'k.md'), 'A: knowledge/k.md preserved');
  assert.ok(exists(claudeDir, '.credentials.json'), 'A: .credentials.json preserved');
  // Now add expX and push into A's overlay.
  fs.writeFileSync(path.join(claudeDir, 'agents', 'expX.md'), 'EXPERIMENT X\n');
  cli('push');
  const cloneA = path.join(sb.clonePath, 'profiles', 'A');
  assert.ok(exists(cloneA, 'agents', 'expX.md'), 'A overlay stores expX.md');
  // A overlay must NOT store base files (identical to base = delta drops them).
  assert.ok(!exists(cloneA, 'CLAUDE.md'), 'A overlay must not store CLAUDE.md (identical to base)');
  assert.ok(
    !exists(cloneA, 'agents', 'self-reviewing-implementer.md'),
    'A overlay must not store self-reviewing-implementer.md (identical to base)'
  );
  say('ASSERT ok: A overlay is a pure delta (only expX.md).');

  // Profile B: create from B while on A. new copies non-layered snapshot; empty overlay.
  cli('new', 'B');
  cli('switch', 'B');
  // On B (empty overlay): layered = base only, expX gone, expY not yet added.
  assert.ok(exists(claudeDir, 'CLAUDE.md'), 'B: base CLAUDE.md present');
  assert.ok(!exists(claudeDir, 'agents', 'expX.md'), 'B: expX must be gone (isolation)');
  fs.writeFileSync(path.join(claudeDir, 'agents', 'expY.md'), 'EXPERIMENT Y\n');
  cli('push');
  const cloneB = path.join(sb.clonePath, 'profiles', 'B');
  assert.ok(exists(cloneB, 'agents', 'expY.md'), 'B overlay stores expY.md');
  say('ASSERT ok: B overlay stores expY.md.');

  // === Step 3: Switch to A: base present, expX present, expY absent ===
  cli('switch', 'A');
  assert.ok(exists(claudeDir, 'CLAUDE.md'), 'switch A: base CLAUDE.md present');
  assert.ok(
    exists(claudeDir, 'agents', 'self-reviewing-implementer.md'),
    'switch A: base self-reviewing-implementer present'
  );
  assert.ok(exists(claudeDir, 'agents', 'expX.md'), 'switch A: expX present');
  assert.ok(!exists(claudeDir, 'agents', 'expY.md'), 'switch A: expY ABSENT');
  say('ASSERT ok: on A -> base + expX present, expY absent.');

  // === Step 4: Switch to B: base present, expY present, expX absent ===
  cli('switch', 'B');
  assert.ok(exists(claudeDir, 'CLAUDE.md'), 'switch B: base CLAUDE.md present');
  assert.ok(
    exists(claudeDir, 'agents', 'self-reviewing-implementer.md'),
    'switch B: base self-reviewing-implementer present'
  );
  assert.ok(exists(claudeDir, 'agents', 'expY.md'), 'switch B: expY present');
  assert.ok(!exists(claudeDir, 'agents', 'expX.md'), 'switch B: expX ABSENT (clean-rebuild isolation)');
  say('ASSERT ok: on B -> base + expY present, expX absent (isolation proven).');

  // === Step 5: Non-layered preserved across all switches ===
  assert.ok(exists(claudeDir, 'knowledge', 'k.md'), 'knowledge/k.md never deleted');
  assert.equal(read(claudeDir, 'knowledge', 'k.md'), 'knowledge k\n', 'knowledge/k.md intact');
  assert.ok(exists(claudeDir, '.credentials.json'), '.credentials.json never deleted');
  assert.equal(
    read(claudeDir, '.credentials.json'),
    '{"secret":"do-not-delete"}\n',
    '.credentials.json intact'
  );
  say('ASSERT ok: non-layered knowledge/k.md and .credentials.json preserved across switches.');

  // === Step 6: Delete A: base untouched, B still resolves to base + Y ===
  // Must not delete active profile — switch to B first (already on B).
  cli('delete', 'A', '--yes');
  // base/ untouched
  assert.ok(exists(cloneBase, 'CLAUDE.md'), 'delete A: base/CLAUDE.md untouched');
  assert.ok(
    exists(cloneBase, 'agents', 'self-reviewing-implementer.md'),
    'delete A: base agents untouched'
  );
  assert.ok(!exists(sb.clonePath, 'profiles', 'A'), 'delete A: profile A dir removed');
  // Re-apply B via pull; it should still resolve to base + Y.
  cli('pull');
  assert.ok(exists(claudeDir, 'CLAUDE.md'), 'after delete A: B base CLAUDE.md present');
  assert.ok(exists(claudeDir, 'agents', 'expY.md'), 'after delete A: B expY present');
  assert.ok(!exists(claudeDir, 'agents', 'expX.md'), 'after delete A: expX still absent');
  say('ASSERT ok: after deleting A, base intact and B resolves to base + Y.');

  say('ALL DoD ASSERTIONS PASSED.');
});

test('legacy (non-overlay) profile behaves as full snapshot (backward compat)', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const cli = (...args) => {
    const r = runCli(sb.env, args);
    assert.equal(r.code, 0, `CLI failed: claude-profile ${args.join(' ')}\n${r.err}`);
    return r;
  };
  const claudeDir = sb.claudeDir;

  // Create a legacy full-snapshot profile.
  cli('new', 'legacy', '--full');
  const cfgPath = path.join(sb.home, '.claude-profile', 'config.json');
  const cfg = JSON.parse(read(cfgPath));
  cfg.activeProfile = 'legacy';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

  // Legacy stores the FULL layered region (identical-to-base logic does not apply).
  const cloneLegacy = path.join(sb.clonePath, 'profiles', 'legacy');
  assert.ok(exists(cloneLegacy, 'CLAUDE.md'), 'legacy stores CLAUDE.md (full snapshot)');
  assert.ok(exists(cloneLegacy, 'agents', 'core.md'), 'legacy stores agents/core.md');
  assert.ok(exists(cloneLegacy, 'knowledge', 'k.md'), 'legacy stores non-layered too');

  // profiles.json must NOT have overlay:true for this profile.
  const pj = JSON.parse(read(sb.clonePath, 'profiles.json'));
  const entry = pj.profiles.find((p) => p.name === 'legacy');
  assert.ok(entry, 'legacy entry exists');
  assert.notEqual(entry.overlay, true, 'legacy profile must not be overlay:true');
});

test('migrate --dry-run reports without writing; migrate flips flag', (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const cli = (...args) => {
    const r = runCli(sb.env, args);
    assert.equal(r.code, 0, `CLI failed: claude-profile ${args.join(' ')}\n${r.err}`);
    return r;
  };

  // Create a legacy profile, then migrate it.
  cli('new', 'old', '--full');
  const pjBefore = JSON.parse(read(sb.clonePath, 'profiles.json'));
  assert.notEqual(
    pjBefore.profiles.find((p) => p.name === 'old')?.overlay,
    true,
    'old starts non-overlay'
  );

  // Dry run must not change anything.
  const dry = cli('migrate', 'old', '--dry-run');
  assert.match(dry.out, /Dry run/i, 'dry run header present');
  const pjAfterDry = JSON.parse(read(sb.clonePath, 'profiles.json'));
  assert.notEqual(
    pjAfterDry.profiles.find((p) => p.name === 'old')?.overlay,
    true,
    'dry run did not flip the flag'
  );

  // Real migrate flips overlay:true.
  cli('migrate', 'old');
  const pjAfter = JSON.parse(read(sb.clonePath, 'profiles.json'));
  assert.equal(
    pjAfter.profiles.find((p) => p.name === 'old')?.overlay,
    true,
    'migrate set overlay:true'
  );
});
