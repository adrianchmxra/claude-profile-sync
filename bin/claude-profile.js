#!/usr/bin/env node

import { Command } from 'commander';
import { init } from '../src/init.js';
import { push } from '../src/push.js';
import { pull } from '../src/pull.js';
import { switchProfile } from '../src/switch.js';
import { list } from '../src/list.js';
import { newProfile } from '../src/new.js';
import { deleteProfile } from '../src/delete.js';
import { renameProfile } from '../src/rename.js';
import { copyProfileToNew } from '../src/copy.js';
import { status } from '../src/status.js';
import { base } from '../src/base.js';
import { migrate } from '../src/migrate.js';

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
  .option('--force', 'Bypass device-ownership check (use when reclaiming a profile on a new device)')
  .action(wrapAction((opts) => pull({ dryRun: opts.dryRun, force: opts.force })));

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
  .description('Create a new profile from current ~/.claude (overlay mode by default)')
  .option('--full', 'Create a legacy full-snapshot profile instead of an overlay profile')
  .action(wrapAction((parts, opts) => newProfile(parts.join(' '), { full: opts.full })));

program
  .command('delete <name...>')
  .description('Delete a profile')
  .option('--yes', 'Skip confirmation prompt')
  .action(wrapAction((parts, opts) => deleteProfile(parts.join(' '), { yes: opts.yes })));

program
  .command('rename <oldName> <newName>')
  .description('Rename a profile (repo-only; quote names containing spaces)')
  .action(wrapAction((oldName, newName) => renameProfile(oldName, newName)));

program
  .command('copy <sourceName> <newName>')
  .description('Copy a profile to a new name, leaving the source untouched')
  .action(wrapAction((sourceName, newName) => copyProfileToNew(sourceName, newName)));

program
  .command('status')
  .description('Show sync status')
  .action(wrapAction(status));

program
  .command('base <sub> [relpath...]')
  .description('Curate the persistent base: base show|add <relpath>|remove <relpath>|pull')
  .option('--from <profile>', 'For "add": source the item from a stored profile instead of ~/.claude')
  .action(wrapAction((sub, relpathParts, opts) => base(sub, relpathParts || [], { from: opts.from })));

program
  .command('migrate [name...]')
  .description('Flip profile(s) to overlay mode and recompute overlay = layered minus base')
  .option('--all', 'Migrate all profiles')
  .option('--dry-run', 'Show what would change without writing/pushing')
  .action(
    wrapAction((parts, opts) =>
      migrate((parts && parts.length ? parts.join(' ') : null), {
        all: opts.all,
        dryRun: opts.dryRun,
      })
    )
  );

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
