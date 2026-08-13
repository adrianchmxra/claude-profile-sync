import fs from 'node:fs';
import path from 'node:path';
import {
  requireConfig,
  getProfilesDir,
  getBaseDir,
  readProfilesJson,
  writeProfilesJson,
  acquireLock,
} from './config.js';
import { pullRepo, commitAndPush } from './git.js';
import {
  loadProfileIgnore,
  getLayeredFiles,
  computeOverlayDelta,
} from './fs.js';

/**
 * Migrate one or more profiles to overlay mode.
 *
 * For each targeted profile:
 *   - set { overlay: true } in profiles.json;
 *   - recompute its stored overlay = current stored layered content minus base
 *     (drop layered files byte-identical to the corresponding base file).
 *
 * With an empty base this is a no-op on effective behaviour (the overlay ends
 * up equal to the full layered region), which is the safe default.
 *
 * @param {string|null} name - profile name (ignored when options.all is set)
 * @param {object} [options] - { all: boolean, dryRun: boolean }
 */
export async function migrate(name, options = {}) {
  const { all = false, dryRun = false } = options;

  if (!all && !name) {
    throw new Error('Usage: claude-profile migrate <name> | migrate --all [--dry-run]');
  }

  const config = requireConfig();

  console.log('Pulling latest from remote...');
  await pullRepo(config);

  const profilesData = readProfilesJson(config);

  let targets;
  if (all) {
    targets = profilesData.profiles.map((p) => p.name);
  } else {
    const entry = profilesData.profiles.find((p) => p.name === name);
    if (!entry) {
      throw new Error(`Profile "${name}" not found.`);
    }
    targets = [name];
  }

  if (targets.length === 0) {
    console.log('No profiles to migrate.');
    return;
  }

  const ig = loadProfileIgnore(config);
  const baseDir = getBaseDir(config);
  const profilesDir = getProfilesDir(config);

  // Plan the changes first (used for both dry-run and the real run).
  const plan = [];
  for (const profileName of targets) {
    const entry = profilesData.profiles.find((p) => p.name === profileName);
    if (!entry) continue;
    const profileDir = path.join(profilesDir, profileName);

    const currentLayered = fs.existsSync(profileDir)
      ? getLayeredFiles(profileDir, ig)
      : [];
    // computeOverlayDelta reads the profile dir as the "claude" side here:
    // it returns the layered files that differ from / are absent in base.
    const keep = fs.existsSync(profileDir)
      ? computeOverlayDelta(profileDir, baseDir, ig)
      : [];
    const keepSet = new Set(keep);
    const drop = currentLayered.filter((f) => !keepSet.has(f));

    plan.push({
      profileName,
      profileDir,
      alreadyOverlay: entry.overlay === true,
      keep,
      drop,
    });
  }

  if (dryRun) {
    console.log('Dry run — migrate to overlay mode:');
    console.log('');
    for (const p of plan) {
      const flag = p.alreadyOverlay ? ' (already overlay)' : ' -> overlay:true';
      console.log(`  ${p.profileName}${flag}`);
      console.log(`    layered kept in overlay (delta over base): ${p.keep.length}`);
      console.log(`    layered dropped (identical to base): ${p.drop.length}`);
      if (p.drop.length > 0) {
        for (const f of p.drop) console.log(`      - ${f}`);
      }
    }
    console.log('');
    console.log('No changes written (dry run).');
    return;
  }

  const releaseLock = acquireLock('migrate');
  try {
    let changed = 0;
    for (const p of plan) {
      const entry = profilesData.profiles.find((pp) => pp.name === p.profileName);
      if (!entry) continue;

      // Drop layered files identical to base from the stored profile.
      for (const relFile of p.drop) {
        try {
          fs.unlinkSync(path.join(p.profileDir, relFile));
        } catch {
          // ignore
        }
      }
      // Flip the flag.
      entry.overlay = true;
      changed++;
      console.log(
        `Migrated "${p.profileName}" -> overlay (kept ${p.keep.length}, dropped ${p.drop.length}).`
      );
    }

    writeProfilesJson(config, profilesData);

    const msg = all
      ? `migrate: all profiles to overlay from ${config.deviceId}`
      : `migrate: "${name}" to overlay from ${config.deviceId}`;
    console.log('Pushing migration to remote...');
    await commitAndPush(config, msg);
    console.log(`Migration complete. ${changed} profile(s) updated.`);
  } finally {
    releaseLock();
  }
}
