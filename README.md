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
claude-profile init                         # First-time setup wizard
claude-profile push [--force] [--dry-run]   # Save ~/.claude to remote
claude-profile pull [--dry-run]             # Restore from remote
claude-profile switch <name>                # Switch profiles (atomic)
claude-profile list                         # List all profiles
claude-profile new <name>                   # Create new profile
claude-profile delete <name> [--yes]        # Delete a profile
claude-profile status                       # Show sync status
```

## How it works

Each profile is a snapshot of your `~/.claude` directory stored in a private GitHub repo:

```
your-profiles-repo/
  profiles/
    home-pc/          # CLAUDE.md, settings.json, agents/, rules/, etc.
    work-laptop/
    work-desktop/
  profiles.json       # Profile metadata
  .profileignore      # Extra exclusion patterns
```

### What gets synced

Everything inside `~/.claude/` **except**:
- `~/.claude.json` (OAuth tokens -- never synced)
- `projects/`, `teams/`, `tasks/`, `memory/` directories
- `.git/`
- Patterns in `.profileignore`

### .profileignore

Add patterns to `.profileignore` in your sync repo to exclude additional files (uses gitignore syntax):

```
*.log
tmp/
*.bak
```

### Switch atomicity

When switching profiles, your current state is snapshot and pushed to remote **before** overwriting `~/.claude`. If the push fails, `~/.claude` is not modified.

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
