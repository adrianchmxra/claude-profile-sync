import { requireConfig, readProfilesJson } from './config.js';
import { pullRepo } from './git.js';

/**
 * List all profiles in the sync repo.
 */
export async function list() {
  const config = requireConfig();

  // Pull latest to show up-to-date list
  try {
    await pullRepo(config);
  } catch {
    // Proceed with local data if pull fails
  }

  const profilesData = readProfilesJson(config);
  const profiles = profilesData.profiles;

  if (profiles.length === 0) {
    console.log('No profiles found. Run "claude-profile new <name>" to create one.');
    return;
  }

  console.log('Profiles:');
  console.log('');
  for (const profile of profiles) {
    const active = profile.name === config.activeProfile ? ' (active)' : '';
    const pushed = profile.lastPushedAt
      ? ` — last pushed ${new Date(profile.lastPushedAt).toLocaleString()}`
      : '';
    console.log(`  ${profile.name}${active}${pushed}`);
  }
  console.log('');
  console.log(`Active profile: ${config.activeProfile}`);
  console.log(`Device: ${config.deviceId}`);
}
