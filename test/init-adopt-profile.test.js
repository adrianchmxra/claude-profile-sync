import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
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


/**
 * Drive the init wizard, answering each prompt as it appears.
 *
 * Answers must be fed prompt-by-prompt rather than written as one chunk:
 * the wizard asks its last question only after cloning, and readline does
 * not reliably retain buffered lines across that gap.
 *
 * PATH is narrowed to a directory containing only `git` so the wizard takes
 * the env-token branch deterministically, rather than depending on whatever
 * `gh auth` returns on the host machine.
 */
function runInit(sb, answers) {
  return new Promise((resolve, reject) => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-bin-'));
    const gitPath = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
    fs.symlinkSync(gitPath, path.join(binDir, 'git'));

    const remaining = [...answers];
    const child = spawn(process.execPath, [CLI, 'init'], {
      env: { ...sb.env, PATH: binDir },
    });
    let out = '';
    let err = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`init timed out. Output so far:\n${out}\n${err}`));
    }, 60000);

    child.stdout.on('data', (d) => {
      out += d;
      // A prompt is written without a trailing newline and ends in ": ".
      if (/: $/.test(out) && remaining.length) {
        child.stdin.write(remaining.shift() + '\n');
      }
    });
    child.stderr.on('data', (d) => (err += d));

    // Release our end of the pipe once the child is gone, otherwise the open
    // write handle keeps the test runner's event loop alive.
    child.on('exit', () => {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(binDir, { recursive: true, force: true });
      resolve({ code, out, err });
    });
  });
}

test('init: a fresh device adopts an existing profile instead of creating one', async (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const cli = (...args) => {
    const r = runCli(sb.env, args);
    assert.equal(r.code, 0, `CLI failed: claude-profile ${args.join(' ')}\n${r.err}`);
    return r;
  };

  // Device A publishes a config-named profile.
  cli('new', 'product', '--full');
  const remoteUrl = JSON.parse(read(sb.cpDir, 'config.json')).repoUrl;
  assert.ok(exists(sb.profilesDir, 'product', 'agents', 'core.md'));

  // Now simulate a different machine: no config, no clone, and a ~/.claude
  // that differs from the stored profile.
  fs.rmSync(sb.cpDir, { recursive: true, force: true });
  fs.rmSync(path.join(sb.claudeDir, 'agents', 'core.md'));

  const r = await runInit(sb, [remoteUrl, 'laptop-b', 'product']);
  assert.equal(r.code, 0, `init failed:\n${r.err}\n${r.out}`);

  // It offered what already exists rather than defaulting to a device name.
  assert.match(r.out, /Profiles already in this repo:/);
  assert.match(r.out, /Adopted existing profile "product"/);

  const cfg = JSON.parse(read(sb.cpDir, 'config.json'));
  assert.equal(cfg.activeProfile, 'product', 'adopted the existing profile');
  assert.equal(cfg.deviceId, 'laptop-b');

  // Adoption must not overwrite the stored profile with this machine's state.
  assert.ok(
    exists(sb.clonePath, 'profiles', 'product', 'agents', 'core.md'),
    'stored profile was left intact, not clobbered by the new device'
  );
  // ...nor silently overwrite ~/.claude.
  assert.ok(
    !exists(sb.claudeDir, 'agents', 'core.md'),
    '~/.claude untouched; the user is told to run pull'
  );
  assert.match(r.out, /claude-profile pull/);

  // Exactly one profile still exists — no device-shaped profile was minted.
  const names = JSON.parse(read(sb.clonePath, 'profiles.json')).profiles.map((p) => p.name);
  assert.deepEqual(names, ['product']);
});

test('init: an empty repo asks for a config name, not a device name', async (t) => {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());

  const remoteUrl = JSON.parse(read(sb.cpDir, 'config.json')).repoUrl;
  fs.rmSync(sb.cpDir, { recursive: true, force: true });

  const r = await runInit(sb, [remoteUrl, 'laptop-b', 'minimal']);
  assert.equal(r.code, 0, `init failed:\n${r.err}\n${r.out}`);

  assert.match(r.out, /Name this profile after the configuration it holds/);
  assert.doesNotMatch(r.out, /Profile name for this device/);

  const cfg = JSON.parse(read(sb.cpDir, 'config.json'));
  assert.equal(cfg.activeProfile, 'minimal');
  const names = JSON.parse(read(sb.clonePath, 'profiles.json')).profiles.map((p) => p.name);
  assert.deepEqual(names, ['minimal']);
});
