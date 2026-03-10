import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'bin', 'claude-profile.js');

/**
 * Plugin entry point for Claude Code slash commands.
 * Handles /profile <subcommand> [args] by shelling out to the CLI.
 */
export default function plugin(params) {
  const { subcommand, args } = params;

  if (!subcommand) {
    return {
      output:
        'Usage: /profile <subcommand> [args]\n\n' +
        'Subcommands:\n' +
        '  list              List all profiles\n' +
        '  switch <name>     Switch to a different profile\n' +
        '  push              Save current ~/.claude to remote\n' +
        '  pull              Restore active profile from remote\n' +
        '  new <name>        Create a new profile\n' +
        '  delete <name>     Delete a profile\n' +
        '  status            Show sync status\n',
    };
  }

  const validSubcommands = [
    'list',
    'switch',
    'push',
    'pull',
    'new',
    'delete',
    'status',
  ];

  if (!validSubcommands.includes(subcommand)) {
    return {
      output: `Unknown subcommand: ${subcommand}\nValid subcommands: ${validSubcommands.join(', ')}`,
    };
  }

  // Build the command
  const cmdParts = ['node', JSON.stringify(CLI_PATH), subcommand];
  if (args) {
    // Split args string and add each part
    const argParts = args.trim().split(/\s+/);
    for (const part of argParts) {
      cmdParts.push(part);
    }
  }

  // For delete, always pass --yes in plugin context (no interactive prompt)
  if (subcommand === 'delete' && !args?.includes('--yes')) {
    cmdParts.push('--yes');
  }

  const cmd = cmdParts.join(' ');

  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { output: output.trim() || 'Done.' };
  } catch (err) {
    const stderr = err.stderr?.trim() || '';
    const stdout = err.stdout?.trim() || '';
    const message = stderr || stdout || err.message;
    return { output: `Error: ${message}` };
  }
}
