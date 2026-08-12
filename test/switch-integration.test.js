import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isLayeredPath } from '../src/fs.js';

// ---------------------------------------------------------------------------
// Rigorous end-to-end integration test for the base + overlay profile-switching
// feature. Drives the REAL CLI (bin/claude-profile.js) as a subprocess with
// CLAUDE_PROFILE_HOME pointed at a per-test sandbox, and a bare local git repo
// acting as the remote (file:// URL) so commit+push work with NO network and
// NO real GitHub. The user's real ~/.claude-profile and adrianchmxra/claude-
// profiles are NEVER touched.
//
// Driving mode: SUBPROCESS (preferred, per task). Every state mutation goes
// through the actual `node bin/claude-profile.js <sub> <args>` command; exit
// code + stdout/stderr are captured; a nonzero exit fails the test EXCEPT where
// a nonzero exit is the asserted behaviour (the atomicity abort test).
//
// SECRETS: this file NEVER reads or copies the contents of any real secret file.
// Files named like secrets (.credentials.json, .mcp.json, history.jsonl) exist
// only as sandbox placeholders with fabricated bodies, to prove they are
// preserved as NON-layered data. Their names mirror the user's real layout;
// their contents are synthetic.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'claude-profile.js');

// ---------------------------------------------------------------------------
// Sandbox: a fake HOME with ~/.claude seeded, a bare git remote, and a cloned
// working data repo wired via config.json + CLAUDE_PROFILE_HOME.
// ---------------------------------------------------------------------------

function gitC(clonePath, args, env) {
  return execFileSync('git', ['-C', clonePath, ...args], { stdio: 'pipe', env });
}

/**
 * Seed a realistic ~/.claude that MIRRORS the user's real repo structure
 * (names/counts only — NO secret contents copied). Adds adversarial cases.
 *
 * Real structure observed (names only, via a path listing):
 *   - CLAUDE.md
 *   - agents/  : 6 agent .md files
 *   - commands/: 9 command .md files
 *   - skills/<name>/SKILL.md   (3-level nesting)
 *   - non-layered: knowledge/, .credentials.json, .mcp.json, history.jsonl,
 *     settings.json, agent-memory/<agent>/, cache/, plans/, ...
 */
function seedClaudeDir(claudeDir) {
  const w = (rel, content) => {
    const full = path.join(claudeDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  // --- Layered region (curated; a subset will become base) ---
  w('CLAUDE.md', 'BASE CLAUDE CONTENT v1\n');
  // 6 agents mirroring real counts (real names where the task references them).
  w('agents/self-reviewing-implementer.md', 'self-reviewing-implementer BASE\n');
  w('agents/post-merge-release.md', 'post-merge-release BASE\n');
  w('agents/scrum-picker.md', 'scrum-picker BASE\n');
  w('agents/legal-compliance-advisor.md', 'legal-compliance-advisor BASE\n');
  w('agents/ux-design-advisor.md', 'ux-design-advisor BASE\n');
  w('agents/web-copywriter.md', 'web-copywriter BASE\n');
  // 9 commands mirroring real counts.
  for (const c of [
    'deploy', 'done', 'next', 'pickup', 'review',
    'ship', 'story-make', 'story-retrieve', 'story-update',
  ]) {
    w(`commands/${c}.md`, `command ${c} BASE\n`);
  }
  // skills: real layout is skills/<name>/SKILL.md.
  w('skills/linear-cli/SKILL.md', 'skill linear-cli BASE\n');
  w('skills/product-planning/SKILL.md', 'skill product-planning BASE\n');

  // --- Non-layered region (must NEVER be deleted by clean-rebuild) ---
  // Secret-bearing filenames: placeholder content only.
  w('.credentials.json', '{"secret":"PLACEHOLDER-do-not-delete"}\n');
  w('.mcp.json', '{"mcpServers":{"placeholder":true}}\n');
  w('history.jsonl', '{"placeholder":"history line"}\n');
  w('settings.json', '{"placeholder":"settings"}\n');
  w('knowledge/base-knowledge.md', 'shared base knowledge\n');
  w('agent-memory/self-reviewing-implementer/mem.md', 'agent memory placeholder\n');

  // --- Adversarial / deceptive NON-layered names that must NOT be treated as
  //     layered (never deleted by clean-rebuild, never pulled into base/overlay). ---
  w('agents-old/n.md', 'deceptive: agents-old is NON-layered\n');
  w('CLAUDE.md.bak', 'deceptive: CLAUDE.md.bak is NON-layered\n');
  w('commands-archive/c.md', 'deceptive: commands-archive is NON-layered\n');
  w('skillset/z.md', 'deceptive: skillset is NON-layered\n');
}

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-switch-'));
  const home = path.join(root, 'home');
  const claudeDir = path.join(home, '.claude');
  const cpDir = path.join(home, '.claude-profile');
  const clonePath = path.join(cpDir, 'repo');
  const bareRemote = path.join(root, 'remote.git');

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(cpDir, { recursive: true });

  seedClaudeDir(claudeDir);

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Sandbox',
    GIT_AUTHOR_EMAIL: 'sandbox@example.com',
    GIT_COMMITTER_NAME: 'Sandbox',
    GIT_COMMITTER_EMAIL: 'sandbox@example.com',
  };

  // Bare remote (the "GitHub").
  execFileSync('git', ['init', '--bare', '-b', 'main', bareRemote], { stdio: 'pipe' });

  // Cloned working data repo.
  execFileSync('git', ['init', '-b', 'main', clonePath], { stdio: 'pipe' });
  gitC(clonePath, ['config', 'user.name', 'Sandbox'], gitEnv);
  gitC(clonePath, ['config', 'user.email', 'sandbox@example.com'], gitEnv);
  const remoteUrl = 'file://' + bareRemote.replace(/\\/g, '/');
  gitC(clonePath, ['remote', 'add', 'origin', remoteUrl], gitEnv);
  fs.writeFileSync(
    path.join(clonePath, 'profiles.json'),
    JSON.stringify({ version: 1, profiles: [] }, null, 2) + '\n'
  );
  gitC(clonePath, ['add', '-A'], gitEnv);
  gitC(clonePath, ['commit', '-m', 'init data repo'], gitEnv);
  gitC(clonePath, ['push', '-u', 'origin', 'main'], gitEnv);

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
    bareRemote,
    remoteUrl,
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

/**
 * Set the active profile directly in config.json (simulates what `init` would
 * do when it first activates a profile — there is no explicit "activate" CLI
 * verb, only `switch`, which requires a prior active profile).
 */
function setActive(cpDir, name) {
  const cfgPath = path.join(cpDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  cfg.activeProfile = name;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Layered-region snapshot helpers (full-set, content-aware).
// ---------------------------------------------------------------------------

/** Walk a directory returning forward-slash relative file paths (files only). */
function walkFiles(baseDir) {
  const results = [];
  if (!fs.existsSync(baseDir)) return results;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        results.push(path.relative(baseDir, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(baseDir);
  return results;
}

/**
 * A content-keyed map of the LAYERED files currently in a directory:
 * { rel -> content } for every layered file. This is the ground truth the
 * invariant checker compares against.
 */
function layeredMap(dir) {
  const map = {};
  for (const rel of walkFiles(dir)) {
    if (isLayeredPath(rel)) {
      map[rel] = fs.readFileSync(path.join(dir, rel), 'utf-8');
    }
  }
  return map;
}

/**
 * Compute the EXPECTED layered map for ~/.claude after switching to a profile:
 * base layered map, then the profile's stored overlay layered map on top
 * (overlay overrides base on filename conflicts).
 */
function expectedLayered(baseDir, profileDir) {
  const expected = { ...layeredMap(baseDir) };
  const overlay = layeredMap(profileDir);
  for (const [rel, content] of Object.entries(overlay)) {
    expected[rel] = content; // overlay wins
  }
  return expected;
}

/**
 * THE ISOLATION-INVARIANT CHECKER.
 *
 * Asserts the layered region of ~/.claude EXACTLY equals (base ∪ activeOverlay)
 * with correct per-file content. Compares FULL sets WITH content — not a few
 * samples. Reports every leftover / missing / wrong-content file.
 *
 * @returns {{ok:boolean, leftover:string[], missing:string[], wrong:Array, report:string}}
 */
function checkIsolationInvariant(claudeDir, baseDir, profileDir, label) {
  const actual = layeredMap(claudeDir);
  const expected = expectedLayered(baseDir, profileDir);

  const actualKeys = new Set(Object.keys(actual));
  const expectedKeys = new Set(Object.keys(expected));

  const leftover = [...actualKeys].filter((k) => !expectedKeys.has(k)).sort();
  const missing = [...expectedKeys].filter((k) => !actualKeys.has(k)).sort();
  const wrong = [];
  for (const k of expectedKeys) {
    if (actualKeys.has(k) && actual[k] !== expected[k]) {
      wrong.push({
        file: k,
        expected: JSON.stringify(expected[k]),
        actual: JSON.stringify(actual[k]),
      });
    }
  }

  const ok = leftover.length === 0 && missing.length === 0 && wrong.length === 0;
  if (!ok) {
    const parts = [`ISOLATION INVARIANT VIOLATED [${label}]:`];
    if (leftover.length) parts.push(`  LEFTOVER (present, must not be): ${leftover.join(', ')}`);
    if (missing.length) parts.push(`  MISSING (expected, absent): ${missing.join(', ')}`);
    if (wrong.length) {
      parts.push('  WRONG CONTENT:');
      for (const w of wrong) {
        parts.push(`    ${w.file}: expected ${w.expected} got ${w.actual}`);
      }
    }
    return { ok, leftover, missing, wrong, report: parts.join('\n') };
  }
  return { ok, leftover, missing, wrong, report: `OK [${label}] (layered == base ∪ active-overlay)` };
}

/** List non-layered files currently in ~/.claude (for the REPORT-only scenario). */
function nonLayeredFiles(claudeDir) {
  return walkFiles(claudeDir)
    .filter((rel) => !isLayeredPath(rel))
    .sort();
}

/**
 * Byte-level fingerprint of an ENTIRE tree: { rel -> sha256(content) } for every
 * regular file (layered AND non-layered). Used by the atomicity test to prove
 * ~/.claude is byte-for-byte unchanged after an aborted switch.
 */
function fingerprintTree(dir) {
  const map = {};
  for (const rel of walkFiles(dir)) {
    map[rel] = createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex');
  }
  return map;
}

/**
 * Diff two tree fingerprints. Returns { changed, added, removed, modified }.
 * `added`/`removed`/`modified` are sorted relative-path lists.
 */
function diffFingerprints(before, after) {
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));
  const added = [...afterKeys].filter((k) => !beforeKeys.has(k)).sort();
  const removed = [...beforeKeys].filter((k) => !afterKeys.has(k)).sort();
  const modified = [...beforeKeys]
    .filter((k) => afterKeys.has(k) && before[k] !== after[k])
    .sort();
  return { changed: added.length + removed.length + modified.length > 0, added, removed, modified };
}

// ===========================================================================
// SCENARIOS 1-7: base + overlay isolation (the core "no mixing" guarantee)
// ===========================================================================

test('switch-integration: base+overlay isolation across a switch hammer (S1-S7)', (t) => {
  const sb = makeSandbox();
  const log = [];
  const say = (m) => log.push(m);
  t.after(() => {
    console.log('\n========== switch-integration scenario log (S1-S7) ==========');
    for (const line of log) console.log(line);
    console.log('========== end scenario log ==========\n');
    sb.cleanup();
  });

  const cli = (...args) => {
    const r = runCli(sb.env, args);
    say(`$ claude-profile ${args.join(' ')}  (exit ${r.code})`);
    if (r.out.trim()) say('  ' + r.out.trim().replace(/\n/g, '\n  '));
    if (r.err.trim()) say('  [stderr] ' + r.err.trim().replace(/\n/g, '\n  '));
    assert.equal(r.code, 0, `CLI failed: claude-profile ${args.join(' ')}\n${r.err}`);
    return r;
  };

  const claudeDir = sb.claudeDir;
  const baseDir = path.join(sb.clonePath, 'base');
  const profDir = (n) => path.join(sb.clonePath, 'profiles', n);

  // --- Bootstrap: seed profile + activate it so there's something to switch from ---
  cli('new', 'seed');
  setActive(sb.cpDir, 'seed');

  // ================= SCENARIO 1: Seed base =================
  cli('base', 'add', 'CLAUDE.md');
  cli('base', 'add', 'agents/self-reviewing-implementer.md');
  const bshow = cli('base', 'show');
  say('--- base show ---\n  ' + bshow.out.trim().replace(/\n/g, '\n  '));
  assert.ok(exists(baseDir, 'CLAUDE.md'), 'S1: base/CLAUDE.md exists');
  assert.ok(
    exists(baseDir, 'agents', 'self-reviewing-implementer.md'),
    'S1: base/agents/self-reviewing-implementer.md exists'
  );
  const baseLayeredKeys = Object.keys(layeredMap(baseDir)).sort();
  assert.deepEqual(
    baseLayeredKeys,
    ['CLAUDE.md', 'agents/self-reviewing-implementer.md'],
    'S1: base holds exactly the two curated files'
  );
  assert.ok(!exists(baseDir, 'knowledge', 'base-knowledge.md'), 'S1: base has no non-layered');
  assert.ok(!exists(baseDir, '.credentials.json'), 'S1: base has no secrets');
  say('SCENARIO 1 PASS: base seeded with exactly {CLAUDE.md, agents/self-reviewing-implementer.md}.');

  // ================= SCENARIO 2: Create overlay profiles A, B, C =================
  // Each created from current ~/.claude (empty overlay), switched onto, given
  // distinguishing layered content, and pushed into its overlay.

  // Profile A: skills s1, s2; unique agent onlyA; overlapping commands/shared.md
  // ("A version"); deep-nested skills/x/y/z.md; a dotfile inside a layered dir;
  // and CLAUDE.md forced byte-identical to base (overlay must DROP it).
  cli('new', 'A');
  cli('switch', 'A'); // layered rebuilt = base only
  fs.mkdirSync(path.join(claudeDir, 'skills', 's1'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 's1', 'SKILL.md'), 'skill s1 (A only)\n');
  fs.mkdirSync(path.join(claudeDir, 'skills', 's2'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 's2', 'SKILL.md'), 'skill s2 (A only)\n');
  fs.writeFileSync(path.join(claudeDir, 'agents', 'onlyA.md'), 'agent only in A\n');
  fs.mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'commands', 'shared.md'), 'SHARED command: A VERSION\n');
  fs.mkdirSync(path.join(claudeDir, 'skills', 'x', 'y'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 'x', 'y', 'z.md'), 'deep A\n');
  fs.writeFileSync(path.join(claudeDir, 'agents', '.hidden.md'), 'hidden agent A\n');
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), read(baseDir, 'CLAUDE.md')); // == base
  fs.mkdirSync(path.join(claudeDir, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'knowledge', 'a.md'), 'knowledge A\n');
  cli('push');

  assert.ok(
    !exists(profDir('A'), 'CLAUDE.md'),
    'S2: A overlay drops CLAUDE.md (byte-identical to base)'
  );
  assert.ok(exists(profDir('A'), 'skills', 's1', 'SKILL.md'), 'S2: A overlay stores s1');
  assert.ok(exists(profDir('A'), 'skills', 's2', 'SKILL.md'), 'S2: A overlay stores s2');
  assert.ok(exists(profDir('A'), 'agents', 'onlyA.md'), 'S2: A overlay stores onlyA agent');
  assert.ok(exists(profDir('A'), 'skills', 'x', 'y', 'z.md'), 'S2: A overlay stores deep-nested skill');
  assert.ok(exists(profDir('A'), 'agents', '.hidden.md'), 'S2: A overlay stores dotfile in layered dir');
  say('SCENARIO 2 (A) PASS: A overlay = pure delta; CLAUDE.md dropped (base-owned).');

  // Profile B: skill s3; unique agent onlyB; commands/shared.md ("B version").
  cli('new', 'B');
  cli('switch', 'B'); // layered = base only
  fs.mkdirSync(path.join(claudeDir, 'skills', 's3'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 's3', 'SKILL.md'), 'skill s3 (B only)\n');
  fs.writeFileSync(path.join(claudeDir, 'agents', 'onlyB.md'), 'agent only in B\n');
  fs.mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'commands', 'shared.md'), 'SHARED command: B VERSION\n');
  fs.writeFileSync(path.join(claudeDir, 'knowledge', 'b.md'), 'knowledge B\n');
  cli('push');
  assert.ok(exists(profDir('B'), 'skills', 's3', 'SKILL.md'), 'S2: B overlay stores s3');
  assert.ok(exists(profDir('B'), 'agents', 'onlyB.md'), 'S2: B overlay stores onlyB agent');
  say('SCENARIO 2 (B) PASS: B overlay stores {s3, onlyB, shared(B)}.');

  // Profile C: skill s4 + unique agent onlyC (for the 3-way hammer).
  cli('new', 'C');
  cli('switch', 'C');
  fs.mkdirSync(path.join(claudeDir, 'skills', 's4'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 's4', 'SKILL.md'), 'skill s4 (C only)\n');
  fs.writeFileSync(path.join(claudeDir, 'agents', 'onlyC.md'), 'agent only in C\n');
  cli('push');
  assert.ok(exists(profDir('C'), 'skills', 's4', 'SKILL.md'), 'S2: C overlay stores s4');
  say('SCENARIO 2 (C) PASS: C overlay stores {s4, onlyC}.');

  // ================= SCENARIO 3: Direct repro A -> B =================
  cli('switch', 'A');
  cli('switch', 'B');
  assert.ok(exists(claudeDir, 'skills', 's3', 'SKILL.md'), 'S3: s3 present on B');
  assert.ok(!exists(claudeDir, 'skills', 's1', 'SKILL.md'), 'S3: s1 ABSENT on B');
  assert.ok(!exists(claudeDir, 'skills', 's2', 'SKILL.md'), 'S3: s2 ABSENT on B');
  assert.ok(!exists(claudeDir, 'skills', 'x', 'y', 'z.md'), 'S3: A deep skill ABSENT on B');
  assert.ok(!exists(claudeDir, 'agents', 'onlyA.md'), 'S3: onlyA agent ABSENT on B');
  assert.ok(exists(claudeDir, 'CLAUDE.md'), 'S3: base CLAUDE.md present on B');
  assert.ok(
    exists(claudeDir, 'agents', 'self-reviewing-implementer.md'),
    'S3: base agent present on B'
  );
  const inv3 = checkIsolationInvariant(claudeDir, baseDir, profDir('B'), 'S3 A->B');
  assert.ok(inv3.ok, inv3.report);
  say('SCENARIO 3 PASS: after A->B, layered == base ∪ B (s3 in, s1/s2 out). ' + inv3.report);

  // ================= SCENARIO 4: Hammer / order-dependence =================
  // A->B->A->C->B->A. After EVERY switch, assert the full content-aware invariant.
  const sequence = ['A', 'B', 'A', 'C', 'B', 'A'];
  for (const target of sequence) {
    cli('switch', target);
    const inv = checkIsolationInvariant(claudeDir, baseDir, profDir(target), `S4 ->${target}`);
    assert.ok(inv.ok, inv.report);
    // Overlapping-filename content must be the ACTIVE profile's version.
    if (target === 'A') {
      assert.equal(
        read(claudeDir, 'commands', 'shared.md'),
        'SHARED command: A VERSION\n',
        `S4 ->A: commands/shared.md must be A's version`
      );
    } else if (target === 'B') {
      assert.equal(
        read(claudeDir, 'commands', 'shared.md'),
        'SHARED command: B VERSION\n',
        `S4 ->B: commands/shared.md must be B's version`
      );
    } else if (target === 'C') {
      assert.ok(
        !exists(claudeDir, 'commands', 'shared.md'),
        `S4 ->C: commands/shared.md must be absent (not in base, not in C)`
      );
    }
    say(`SCENARIO 4 step ->${target}: ${inv.report}`);
  }
  say('SCENARIO 4 PASS: invariant held after every switch in A->B->A->C->B->A.');

  // ================= SCENARIO 5: Base persistence =================
  assert.equal(read(claudeDir, 'CLAUDE.md'), 'BASE CLAUDE CONTENT v1\n', 'S5: base CLAUDE.md content intact');
  assert.equal(
    read(claudeDir, 'agents', 'self-reviewing-implementer.md'),
    'self-reviewing-implementer BASE\n',
    'S5: base agent content intact'
  );
  const baseKeysNow = Object.keys(layeredMap(baseDir)).sort();
  assert.deepEqual(baseKeysNow, ['CLAUDE.md', 'agents/self-reviewing-implementer.md'], 'S5: base/ unchanged');
  say('SCENARIO 5 PASS: base present & unmodified after every switch.');

  // ================= SCENARIO 6: Non-layered behavior (REPORT, no hard-fail) =====
  const nonLayeredNow = nonLayeredFiles(claudeDir);
  const aPersists = exists(claudeDir, 'knowledge', 'a.md');
  const bPersists = exists(claudeDir, 'knowledge', 'b.md');
  say('----- NON-LAYERED CROSS-PROFILE REPORT (informational) -----');
  say(`  Active profile at report time: A (end of hammer sequence).`);
  say(`  knowledge/a.md (created while on A) present now? ${aPersists}`);
  say(`  knowledge/b.md (created while on B) present now? ${bPersists}`);
  say(`  Full non-layered file list in ~/.claude:`);
  for (const f of nonLayeredNow) say(`    ${f}`);
  say('  Interpretation: non-layered data is ADDITIVE (never deleted). Files');
  say('  created under any profile accumulate in ~/.claude and get copied into');
  say("  whichever overlay is active at push time. B's knowledge/b.md therefore");
  say('  persists into A and would be stored into A on the next push. This is');
  say('  the documented design ("non-layered data is additive, never deleted").');
  say('----- END NON-LAYERED REPORT -----');
  assert.ok(exists(claudeDir, '.credentials.json'), 'S6: .credentials.json never deleted');
  assert.ok(exists(claudeDir, '.mcp.json'), 'S6: .mcp.json never deleted');
  assert.ok(exists(claudeDir, 'history.jsonl'), 'S6: history.jsonl never deleted');
  say('SCENARIO 6 REPORTED: additive non-layered behavior logged; no hard-fail (design question).');

  // ================= SCENARIO 7: Deceptive names stay NON-layered =================
  for (const f of ['agents-old/n.md', 'CLAUDE.md.bak', 'commands-archive/c.md', 'skillset/z.md']) {
    assert.ok(
      fs.existsSync(path.join(claudeDir, f)),
      `S7: deceptive non-layered "${f}" must survive clean-rebuild`
    );
    assert.ok(!isLayeredPath(f), `S7: isLayeredPath("${f}") must be false`);
    assert.ok(!fs.existsSync(path.join(baseDir, f)), `S7: "${f}" must NOT be in base/`);
  }
  for (const p of ['A', 'B', 'C']) {
    const overlayLayered = Object.keys(layeredMap(profDir(p)));
    for (const dec of ['agents-old/n.md', 'CLAUDE.md.bak', 'commands-archive/c.md', 'skillset/z.md']) {
      assert.ok(
        !overlayLayered.includes(dec),
        `S7: profile ${p} overlay must not treat "${dec}" as layered`
      );
    }
  }
  say('SCENARIO 7 PASS: deceptive names (agents-old, CLAUDE.md.bak, commands-archive, skillset) stay NON-layered.');

  say('ALL CORE SCENARIOS (1-7) PASSED.');
});

// ===========================================================================
// SCENARIO 8: backward-compat with legacy full-snapshot profiles
// ===========================================================================

test('switch-integration: backward-compat with legacy full-snapshot profiles (S8)', (t) => {
  const sb = makeSandbox();
  const log = [];
  const say = (m) => log.push(m);
  t.after(() => {
    console.log('\n========== legacy-compat scenario log (S8) ==========');
    for (const line of log) console.log(line);
    console.log('========== end legacy-compat log ==========\n');
    sb.cleanup();
  });
  const cli = (...args) => {
    const r = runCli(sb.env, args);
    say(`$ claude-profile ${args.join(' ')}  (exit ${r.code})`);
    if (r.out.trim()) say('  ' + r.out.trim().replace(/\n/g, '\n  '));
    assert.equal(r.code, 0, `CLI failed: claude-profile ${args.join(' ')}\n${r.err}`);
    return r;
  };
  const claudeDir = sb.claudeDir;
  const profDir = (n) => path.join(sb.clonePath, 'profiles', n);

  // legacy1: full snapshot of the seeded ~/.claude.
  cli('new', 'legacy1', '--full');
  setActive(sb.cpDir, 'legacy1');
  assert.ok(exists(profDir('legacy1'), 'CLAUDE.md'), 'S8: legacy1 stores CLAUDE.md (full)');
  assert.ok(exists(profDir('legacy1'), 'agents', 'web-copywriter.md'), 'S8: legacy1 stores all agents');
  assert.ok(exists(profDir('legacy1'), 'knowledge', 'base-knowledge.md'), 'S8: legacy1 stores non-layered');
  const pj1 = JSON.parse(read(sb.clonePath, 'profiles.json'));
  assert.notEqual(
    pj1.profiles.find((p) => p.name === 'legacy1')?.overlay,
    true,
    'S8: legacy1 must NOT be overlay:true'
  );

  // Diverge ~/.claude: add a legacy1-unique layered file + remove an agent; push.
  fs.writeFileSync(path.join(claudeDir, 'agents', 'legacy1-only.md'), 'legacy1 unique\n');
  fs.unlinkSync(path.join(claudeDir, 'agents', 'web-copywriter.md'));
  cli('push');
  assert.ok(exists(profDir('legacy1'), 'agents', 'legacy1-only.md'), 'S8: legacy1 push stored new file');
  assert.ok(
    !exists(profDir('legacy1'), 'agents', 'web-copywriter.md'),
    'S8: legacy1 true-sync deleted the removed agent (post-PR#9 true-sync)'
  );

  // legacy2: second full-snapshot profile from the current ~/.claude.
  cli('new', 'legacy2', '--full');
  cli('switch', 'legacy2'); // legacy true-sync
  fs.writeFileSync(path.join(claudeDir, 'agents', 'legacy2-only.md'), 'legacy2 unique\n');
  cli('push');

  // Switch back to legacy1: true-sync restores EXACTLY legacy1's snapshot.
  cli('switch', 'legacy1');
  assert.ok(exists(claudeDir, 'agents', 'legacy1-only.md'), 'S8: legacy1 restore keeps legacy1-only');
  assert.ok(
    !exists(claudeDir, 'agents', 'legacy2-only.md'),
    'S8: legacy1 restore deletes legacy2-only (clean true-sync, no cross-contamination)'
  );
  assert.ok(
    !exists(claudeDir, 'agents', 'web-copywriter.md'),
    'S8: legacy1 restore does not resurrect the removed agent'
  );
  assert.ok(exists(claudeDir, '.credentials.json'), 'S8: legacy non-layered preserved in snapshot');
  say('SCENARIO 8 PASS: two legacy profiles switch with clean true-sync semantics, no regression.');
});

// ===========================================================================
// SCENARIO 9: atomicity — push failure aborts before touching ~/.claude
// ===========================================================================

test('switch-integration: atomicity — push failure aborts before touching ~/.claude (S9)', (t) => {
  const sb = makeSandbox();
  const log = [];
  const say = (m) => log.push(m);
  t.after(() => {
    console.log('\n========== atomicity scenario log (S9) ==========');
    for (const line of log) console.log(line);
    console.log('========== end atomicity log ==========\n');
    sb.cleanup();
  });
  const cli = (...args) => {
    const r = runCli(sb.env, args);
    say(`$ claude-profile ${args.join(' ')}  (exit ${r.code})`);
    if (r.out.trim()) say('  ' + r.out.trim().replace(/\n/g, '\n  '));
    if (r.err.trim()) say('  [stderr] ' + r.err.trim().replace(/\n/g, '\n  '));
    assert.equal(r.code, 0, `CLI failed: claude-profile ${args.join(' ')}\n${r.err}`);
    return r;
  };
  const claudeDir = sb.claudeDir;
  const profDir = (n) => path.join(sb.clonePath, 'profiles', n);

  // Set up base + two overlay profiles Aa (s1) and Bb (s3).
  cli('new', 'seed');
  setActive(sb.cpDir, 'seed');
  cli('base', 'add', 'CLAUDE.md');

  cli('new', 'Aa');
  cli('switch', 'Aa');
  fs.mkdirSync(path.join(claudeDir, 'skills', 's1'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 's1', 'SKILL.md'), 'skill s1 (Aa)\n');
  cli('push');

  cli('new', 'Bb');
  cli('switch', 'Bb');
  fs.mkdirSync(path.join(claudeDir, 'skills', 's3'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 's3', 'SKILL.md'), 'skill s3 (Bb)\n');
  cli('push');

  // Go to Aa and make a LOCAL change so the pre-switch snapshot has something to
  // push (else the snapshot step is skipped and there is no push to fail).
  cli('switch', 'Aa');
  fs.writeFileSync(path.join(claudeDir, 'skills', 's1', 'SKILL.md'), 'skill s1 (Aa MODIFIED)\n');

  // Capture ~/.claude layered state BEFORE the doomed switch, AND a byte-level
  // fingerprint of the ENTIRE tree (layered + non-layered) so we can prove the
  // whole directory is untouched after the abort, not just the layered region.
  const before = layeredMap(claudeDir);
  const treeBefore = fingerprintTree(claudeDir);

  // Make the snapshot PUSH fail while PULL still succeeds — this exercises the
  // specific path the atomicity guarantee protects: a push failure DURING the
  // pre-switch snapshot (Step 3), after Step 1's pull has already succeeded.
  //
  // We install a `pre-receive` hook on the bare remote that rejects every push.
  // Fetch/pull is unaffected (hooks only run on receive), so _doSwitch reaches
  // Step 3, snapshots the current profile, then FAILS to push -> commitAndPush
  // throws -> switch.js aborts with "ABORTED ... ~/.claude was NOT modified"
  // BEFORE the point of no return.
  const hooksDir = path.join(sb.bareRemote, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const preReceive = path.join(hooksDir, 'pre-receive');
  fs.writeFileSync(
    preReceive,
    '#!/bin/sh\necho "remote: push rejected by test hook" 1>&2\nexit 1\n'
  );
  fs.chmodSync(preReceive, 0o755);

  // Sanity: a manual push to the remote must now be rejected (pull still works).
  let pushRejected = false;
  try {
    execFileSync('git', ['-C', sb.clonePath, 'fetch', 'origin', 'main'], {
      stdio: 'pipe',
      env: sb.env,
    });
  } catch {
    throw new Error('S9 setup error: fetch/pull should still succeed with a pre-receive hook.');
  }
  try {
    // Make a throwaway commit and try to push it directly.
    fs.writeFileSync(path.join(sb.clonePath, '.push-probe'), 'probe\n');
    execFileSync('git', ['-C', sb.clonePath, 'add', '-A'], { stdio: 'pipe', env: sb.env });
    execFileSync('git', ['-C', sb.clonePath, 'commit', '-m', 'probe'], { stdio: 'pipe', env: sb.env });
    execFileSync('git', ['-C', sb.clonePath, 'push', 'origin', 'main'], { stdio: 'pipe', env: sb.env });
  } catch {
    pushRejected = true;
  } finally {
    // Undo the probe commit so the clone is back to a clean pushable-content state
    // (the switch's own pull/commit will drive the real attempt).
    try {
      execFileSync('git', ['-C', sb.clonePath, 'reset', '--hard', 'HEAD~1'], { stdio: 'pipe', env: sb.env });
    } catch {
      // ignore
    }
  }
  assert.ok(pushRejected, 'S9 setup: remote must reject pushes (pre-receive hook active)');
  say('S9 setup: pre-receive hook installed — pull works, push is rejected.');

  // Attempt the switch Aa -> Bb. Step 1 pull succeeds; Step 3 snapshot push
  // FAILS -> abort. ~/.claude MUST be left UNTOUCHED and exit MUST be nonzero.
  const r = runCli(sb.env, ['switch', 'Bb']);
  say(`$ claude-profile switch Bb  (exit ${r.code})  [expected nonzero]`);
  if (r.out.trim()) say('  ' + r.out.trim().replace(/\n/g, '\n  '));
  if (r.err.trim()) say('  [stderr] ' + r.err.trim().replace(/\n/g, '\n  '));

  assert.notEqual(r.code, 0, 'S9: doomed switch must exit NONZERO');
  const combined = r.out + r.err;
  assert.match(
    combined,
    /ABORTED|Failed to push|NOT modified/i,
    'S9: output must indicate an abort-before-apply (snapshot push failure)'
  );
  // The pull step (Step 1) must have succeeded before the push failure, proving
  // the failure was at the snapshot-push stage, not the pull stage.
  assert.match(
    r.out,
    /Step 3\/7: Pushing snapshot to remote|Saving local changes/i,
    'S9: switch must have reached the snapshot stage before failing'
  );

  // ~/.claude layered region must be BYTE-IDENTICAL to before (untouched).
  const after = layeredMap(claudeDir);
  assert.deepEqual(
    Object.keys(after).sort(),
    Object.keys(before).sort(),
    'S9: ~/.claude layered file SET unchanged after aborted switch'
  );
  for (const k of Object.keys(before)) {
    assert.equal(after[k], before[k], `S9: ~/.claude layered file "${k}" content unchanged`);
  }

  // Stronger: the ENTIRE ~/.claude tree (layered + non-layered) must be
  // byte-for-byte identical to the pre-switch fingerprint. A single added,
  // removed, or modified file anywhere would fail here with an explicit list.
  const treeAfter = fingerprintTree(claudeDir);
  const treeDiff = diffFingerprints(treeBefore, treeAfter);
  assert.ok(
    !treeDiff.changed,
    'S9: entire ~/.claude tree must be byte-for-byte unchanged after aborted switch. ' +
      `added=[${treeDiff.added.join(', ')}] removed=[${treeDiff.removed.join(', ')}] ` +
      `modified=[${treeDiff.modified.join(', ')}]`
  );
  assert.ok(!exists(claudeDir, 'skills', 's3', 'SKILL.md'), 'S9: Bb overlay (s3) NOT applied after abort');
  assert.ok(exists(claudeDir, 'skills', 's1', 'SKILL.md'), 'S9: Aa s1 still present after abort');
  assert.equal(
    read(claudeDir, 'skills', 's1', 'SKILL.md'),
    'skill s1 (Aa MODIFIED)\n',
    'S9: local modification to s1 preserved (nothing overwritten)'
  );
  say('SCENARIO 9 PASS: push failure during pre-switch snapshot aborted cleanly; ~/.claude untouched, exit nonzero.');
});

// ===========================================================================
// NEGATIVE CONTROL — prove the isolation-invariant checker has TEETH.
// Construct KNOWN-BAD states and assert the checker DETECTS each violation.
// If the checker returned ok=true on a bad state, the suite would be green-by-
// construction; this proves it can genuinely fail (leftover / wrong / missing).
// ===========================================================================

test('switch-integration: NEGATIVE CONTROL — checker detects planted violations', (t) => {
  const sb = makeSandbox();
  const log = [];
  const say = (m) => log.push(m);
  t.after(() => {
    console.log('\n========== negative-control log ==========');
    for (const line of log) console.log(line);
    console.log('========== end negative-control log ==========\n');
    sb.cleanup();
  });
  const cli = (...args) => {
    const r = runCli(sb.env, args);
    say(`$ claude-profile ${args.join(' ')}  (exit ${r.code})`);
    assert.equal(r.code, 0, `CLI failed: claude-profile ${args.join(' ')}\n${r.err}`);
    return r;
  };
  const claudeDir = sb.claudeDir;
  const baseDir = path.join(sb.clonePath, 'base');
  const profDir = (n) => path.join(sb.clonePath, 'profiles', n);

  cli('new', 'seed');
  setActive(sb.cpDir, 'seed');
  cli('base', 'add', 'CLAUDE.md');

  cli('new', 'A');
  cli('switch', 'A');
  fs.mkdirSync(path.join(claudeDir, 'skills', 's1'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 's1', 'SKILL.md'), 'skill s1 (A)\n');
  cli('push');

  cli('new', 'B');
  cli('switch', 'B');
  fs.mkdirSync(path.join(claudeDir, 'skills', 's3'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 's3', 'SKILL.md'), 'skill s3 (B)\n');
  cli('push');

  // Clean switch to B — the checker MUST pass here (precondition).
  cli('switch', 'B');
  const good = checkIsolationInvariant(claudeDir, baseDir, profDir('B'), 'NC clean B');
  assert.ok(good.ok, 'NC precondition: clean B must pass invariant\n' + good.report);
  say('NEGATIVE CONTROL precondition: clean B passes invariant. ' + good.report);

  // --- Case 1: plant a LEFTOVER file (s1 belongs to A, not B). ---
  fs.mkdirSync(path.join(claudeDir, 'skills', 's1'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 's1', 'SKILL.md'), 'LEFTOVER from A (planted)\n');
  const bad1 = checkIsolationInvariant(claudeDir, baseDir, profDir('B'), 'NC planted leftover');
  assert.equal(bad1.ok, false, 'NC case1: checker MUST detect the planted leftover s1');
  assert.ok(
    bad1.leftover.includes('skills/s1/SKILL.md'),
    'NC case1: checker must name the leftover file skills/s1/SKILL.md'
  );
  say('NEGATIVE CONTROL case 1 (leftover) DETECTED: ' + bad1.report.replace(/\n/g, ' | '));

  // --- Case 2: WRONG CONTENT (corrupt s3 so it no longer matches B). ---
  fs.rmSync(path.join(claudeDir, 'skills', 's1'), { recursive: true, force: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 's3', 'SKILL.md'), 'CORRUPTED s3 content\n');
  const bad2 = checkIsolationInvariant(claudeDir, baseDir, profDir('B'), 'NC wrong content');
  assert.equal(bad2.ok, false, 'NC case2: checker MUST detect wrong content for s3');
  assert.ok(
    bad2.wrong.some((w) => w.file === 'skills/s3/SKILL.md'),
    'NC case2: checker must flag skills/s3/SKILL.md as wrong-content'
  );
  say('NEGATIVE CONTROL case 2 (wrong content) DETECTED: ' + bad2.report.replace(/\n/g, ' | '));

  // --- Case 3: MISSING expected file (remove s3 entirely). ---
  fs.rmSync(path.join(claudeDir, 'skills', 's3'), { recursive: true, force: true });
  const bad3 = checkIsolationInvariant(claudeDir, baseDir, profDir('B'), 'NC missing');
  assert.equal(bad3.ok, false, 'NC case3: checker MUST detect a missing expected file');
  assert.ok(
    bad3.missing.includes('skills/s3/SKILL.md'),
    'NC case3: checker must name the missing file skills/s3/SKILL.md'
  );
  say('NEGATIVE CONTROL case 3 (missing) DETECTED: ' + bad3.report.replace(/\n/g, ' | '));

  say('NEGATIVE CONTROL PASS: checker detects leftover, wrong-content, and missing — the suite has teeth.');
});
