---
description: "Manage claude-profile-sync: list, switch, push, pull, create, delete, or check status of Claude Code profiles"
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
| new | `claude-profile new <name>` | Create a new profile from current ~/.claude |
| delete | `claude-profile delete <name> --yes` | Delete a profile |
| status | `claude-profile status` | Show active profile, device, and sync status |

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
