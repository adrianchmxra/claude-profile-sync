# claude-profile-sync

Developers often work across multiple machines: a home PC, a work laptop, maybe a client-provided device. Every time you switch, your Claude Code setup (global instructions, custom agents, rules, plugins, settings) is different or missing entirely. There's no built-in way to keep `~/.claude` in sync across devices.

claude-profile-sync solves this by using a private GitHub repository as the backend. Each device gets a named profile, and switching between them is a single command. Your current state is always snapshot before a switch, so nothing gets lost.

## Prerequisites

- **Node.js** >= 18
- **Git** on PATH
- **GitHub CLI** (`gh`): recommended, makes setup instant. Or a GitHub PAT with `repo` scope.

## Quick start

```bash
# Install from GitHub
npm install -g git+https://github.com/adrianchmxra/claude-profile-sync.git

# Or clone and link locally
git clone https://github.com/adrianchmxra/claude-profile-sync.git
cd claude-profile-sync
npm install
npm link

# First-time setup
claude-profile init
```

If you have the [GitHub CLI](https://cli.github.com) installed and authenticated, init will:
1. Detect your `gh` auth automatically (no PAT needed)
2. Offer to create the `claude-profiles` repo for you
3. Set up your first profile from your current `~/.claude`

Without `gh`, the wizard will ask for a repo URL and PAT manually.

## Commands

```
claude-profile init                            # First-time setup wizard
claude-profile push [--force] [--dry-run]      # Save ~/.claude to remote
claude-profile pull [--dry-run] [--force]      # Restore from remote
claude-profile switch <name>                   # Switch profiles (atomic)
claude-profile list                            # List all profiles
claude-profile new <name> [--full]             # Create new profile (overlay by default)
claude-profile delete <name> [--yes]           # Delete a profile
claude-profile rename <old> <new>              # Rename a profile (repo-only)
claude-profile copy <source> <new>             # Copy a profile, leaving the source intact
claude-profile status                          # Show sync status
claude-profile base show                       # List the curated persistent base
claude-profile base add <relpath>              # Add a layered item into the base
claude-profile base add <relpath> --from <profile>   # ...sourced from a stored profile
claude-profile base remove <relpath>           # Remove an item from the base
claude-profile base pull                       # Apply base to ~/.claude (no switch)
claude-profile migrate <name>                  # Convert a profile to overlay mode
claude-profile migrate --all [--dry-run]       # Convert all profiles to overlay mode
```

## How it works

Each profile is a snapshot of your `~/.claude` directory stored in a private GitHub repo:

```
your-profiles-repo/
  base/               # Curated persistent layered files (CLAUDE.md, agents/, commands/, skills/)
  profiles/
    home-pc/          # Non-layered snapshot + layered OVERLAY (delta over base)
    work-laptop/
    work-desktop/
  profiles.json       # Profile metadata (overlay profiles carry "overlay": true)
  .profileignore      # Extra exclusion patterns
```

### What gets synced

Everything inside `~/.claude/` **except**:
- `~/.claude.json` (OAuth tokens -- never synced)
- `projects/`, `teams/`, `tasks/`, `memory/`, `sessions/` directories
- `.git/`, `.device-id`
- Patterns in `.profileignore`

For **overlay profiles**, the syncable set is further split: the layered region
(`CLAUDE.md`, `agents/`, `commands/`, `skills/`) is rebuilt from base + overlay
on switch/pull, while all other syncable (non-layered) data is applied additively
and never deleted. See [Base + swappable overlay](#base--swappable-overlay).

### .profileignore

Add patterns to `.profileignore` in your sync repo to exclude additional files (uses gitignore syntax):

```
*.log
tmp/
*.bak
```

### Base + swappable overlay

Overlay mode lets you keep a curated **base** setup that persists across every
profile, while auditioning whole candidate skill/agent sets on top of it safely.

`~/.claude` is split into two regions:

- **Layered region** — `CLAUDE.md`, `agents/`, `commands/`, `skills/`. On every
  switch/pull this region is **fully reconstructed** as **base + overlay**:
  1. the layered region in `~/.claude` is wiped,
  2. the persistent `base/` layered files are applied,
  3. the active profile's overlay (its layered delta over base) is applied on top.

  This **clean rebuild** means stale layered files from the previously active
  overlay are removed, so profiles are isolated from one another. A profile's
  stored overlay is a **pure delta**: layered files identical to base are not
  stored, and files you delete locally are dropped from the overlay.

- **Non-layered data** — credentials, `.mcp.json`, `knowledge/`, history,
  caches, and everything in the built-in exclusion list. This is treated
  **additively and is never deleted** by a switch/pull. Your secrets and
  accumulated knowledge follow you across every profile.

Curate the base explicitly (nothing is auto-selected):

```bash
claude-profile base add agents/self-reviewing-implementer.md   # promote a file to base
claude-profile base add commands                               # promote a whole layered dir
claude-profile base show                                       # see what's in base
claude-profile base remove agents/old.md                       # demote from base
claude-profile base pull                                       # adopt base into ~/.claude now
```

`base add` normally reads from `~/.claude`. On a machine whose `~/.claude` is
empty — a fresh device, before any pull — pass `--from` to source the item
from a profile already stored in the repo instead:

```bash
claude-profile base add agents/core.md --from "Home PC"   # promote from a stored profile
claude-profile base add agents --from "Home PC"           # ...or a whole layered dir
```

> **`base pull` is destructive to the layered region.** It rebuilds
> `CLAUDE.md`, `agents/`, `commands/` and `skills/` from base alone, so any
> layered file not in base is deleted. Non-layered data is never touched.

### Restructuring profiles

`rename` and `copy` are repo-only — they never read or write `~/.claude`, so
unlike `switch`/`pull`/`base pull` they work with Claude Code running:

```bash
claude-profile copy "Home PC" product     # derive a new profile from an old one
claude-profile rename "Home PC" product   # relabel in place
```

Copy first, verify, then `delete` the original — that way a restructure never
passes through a state where the old profile is already gone. A copy starts
**unowned** (it does not inherit the source's `.device-id`), so the first
device to push claims it. A rename keeps ownership, since it is the same
profile under a new label.

New profiles are **overlay profiles** by default (empty overlay, so a fresh
profile resolves to pure base). Pass `--full` to `new` for a legacy full
snapshot instead. Convert existing profiles with `migrate <name>` or
`migrate --all` (add `--dry-run` to preview). With an empty base, migrating is a
no-op on effective behavior — the overlay simply equals the full layered region.

Legacy profiles (those without `"overlay": true` in `profiles.json`) keep the
original full-snapshot behavior unchanged.

### Switch atomicity

When switching profiles, your current state is snapshot and pushed to remote **before** overwriting `~/.claude`. If the push fails, `~/.claude` is not modified. This guarantee is preserved for overlay profiles — the current profile's overlay delta is snapshotted and pushed before the target is applied.

### Conflict handling

If two devices push without pulling first, the push will be rejected. You'll be prompted to:
- `--force`: overwrite remote with your local state
- Run `claude-profile pull` first to get the latest, then push again

No automatic merging: profiles are treated as opaque snapshots.

## Claude Code plugin

Load as a plugin to get the `/profile` slash command inside Claude Code:

```bash
# Load during a session
claude --plugin-dir /path/to/claude-profile-sync

# Or install permanently (once published)
/plugin install claude-profile-sync
```

Then use inside Claude Code:

```
/claude-profile-sync:profile list
/claude-profile-sync:profile switch work-laptop
/claude-profile-sync:profile push
/claude-profile-sync:profile pull
/claude-profile-sync:profile status
```

## Configuration

Stored at `~/.claude-profile/config.json` (permissions: 600 on Unix):

```json
{
  "repoUrl": "https://github.com/you/claude-profiles",
  "token": "<GitHub PAT or gh auth token>",
  "deviceId": "home-desktop-win32",
  "activeProfile": "home-pc",
  "clonePath": "~/.claude-profile/repo"
}
```

The token is stored locally only and never committed to the sync repo.
