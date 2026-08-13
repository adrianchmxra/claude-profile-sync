---
description: "Manage claude-profile-sync: list, switch, push, pull, create, delete, check status, curate the base, or migrate profiles to overlay mode"
---

You are handling the `/profile` command for claude-profile-sync. This tool syncs the user's `~/.claude` directory across devices via a private GitHub repo.

The user's request: $ARGUMENTS

## Available subcommands

Run these via the Bash tool. The `claude-profile` CLI must be on PATH (installed via `npm link` or `npm install -g`).

| Subcommand | Command | Description |
|---|---|---|
| list | `claude-profile list` | List all profiles, shows which is active |
| switch | `claude-profile switch <name>` | Switch to a different profile (atomic) |
| push | `claude-profile push` | Save current ~/.claude to remote |
| pull | `claude-profile pull` | Restore active profile from remote |
| new | `claude-profile new <name> [--full]` | Create a new profile (overlay mode by default; `--full` = legacy full snapshot) |
| delete | `claude-profile delete <name> --yes` | Delete a profile |
| status | `claude-profile status` | Show active profile, device, and sync status |
| base show | `claude-profile base show` | List the curated persistent base (layered files) |
| base add | `claude-profile base add <relpath>` | Add a layered item (e.g. `agents/foo.md`, or a dir like `commands`) from ~/.claude into the base |
| base remove | `claude-profile base remove <relpath>` | Remove an item from the base |
| base pull | `claude-profile base pull` | Apply the current base layered files to ~/.claude (adopt base without switching profiles) |
| migrate | `claude-profile migrate <name>` / `migrate --all [--dry-run]` | Flip profile(s) to overlay mode and recompute overlay = layered minus base |

## Base + swappable overlay model

Profiles created after this feature are **overlay profiles**. The `~/.claude`
directory is split into two regions:

- **Layered region** (`CLAUDE.md`, `agents/`, `commands/`, `skills/`): on every
  switch/pull this is fully reconstructed as **base + overlay**. The persistent
  **base** is curated by the user (`base add`/`base remove`) and applies under
  every profile. Each profile stores only its **overlay** = the layered files
  that differ from base. Switching does a **clean rebuild**: stale layered files
  from the previous overlay are removed, so profiles are isolated.
- **Non-layered data** (credentials, `.mcp.json`, `knowledge/`, history, caches,
  and everything in the built-in exclusion list): this is treated additively and
  is **never deleted** by a profile switch/pull.

Legacy profiles (no `overlay:true` in `profiles.json`) keep the original
full-snapshot behavior unchanged. Use `migrate` to convert them.

## Instructions

1. Parse the user's request to determine which subcommand and arguments to use
2. Run the appropriate `claude-profile` command via Bash
3. Show the output to the user
4. If the command fails, show the error and suggest next steps

If the user just says `/profile` with no arguments, show the list of available subcommands.

If `claude-profile` is not found, tell the user to run:
```
cd <project-path> && npm link
```
Or install from GitHub:
```
npm install -g git+https://github.com/adrianchmxra/claude-profile-sync.git
```
