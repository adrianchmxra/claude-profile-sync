#!/usr/bin/env node

import { Command } from 'commander';
import { init } from '../src/init.js';
import { push } from '../src/push.js';
import { pull } from '../src/pull.js';
import { switchProfile } from '../src/switch.js';
import { list } from '../src/list.js';
import { newProfile } from '../src/new.js';
import { deleteProfile } from '../src/delete.js';
import { status } from '../src/status.js';

const program = new Command();

program
  .name('claude-profile')
  .description('Sync ~/.claude profiles across devices via a private GitHub repo')
  .version('1.0.0');

program
  .command('init')
  .description('First-time setup wizard')
  .action(wrapAction(init));

program
  .command('push')
  .description('Save current ~/.claude to the active profile on remote')
  .option('--force', 'Force-push, overwriting remote history')
  .option('--dry-run', 'Show what would be pushed without making changes')
  .action(wrapAction((opts) => push({ force: opts.force, dryRun: opts.dryRun })));

program
  .command('pull')
  .description('Restore the active profile from remote to ~/.claude')
  .option('--dry-run', 'Show what would be pulled without making changes')
  .action(wrapAction((opts) => pull({ dryRun: opts.dryRun })));

program
  .command('switch <name...>')
  .description('Switch to a different profile (atomic snapshot + swap)')
  .action(wrapAction((parts) => switchProfile(parts.join(' '))));

program
  .command('list')
  .description('List all profiles')
  .action(wrapAction(list));

program
  .command('new <name...>')
  .description('Create a new profile from current ~/.claude')
  .action(wrapAction((parts) => newProfile(parts.join(' '))));

program
  .command('delete <name...>')
  .description('Delete a profile')
  .option('--yes', 'Skip confirmation prompt')
  .action(wrapAction((parts, opts) => deleteProfile(parts.join(' '), { yes: opts.yes })));

program
  .command('status')
  .description('Show sync status')
  .action(wrapAction(status));

program.parse();

/**
 * Wrap an async action to handle errors gracefully.
 * Shows human-readable messages instead of raw stack traces.
 */
function wrapAction(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  };
}
