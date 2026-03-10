# claude-profile

Sync your `~/.claude` directory across devices via a private GitHub repo.

## Quick start

```bash
# Install globally
npm install -g claude-profile

# First-time setup
claude-profile init
```

The init wizard will ask for:
- A private GitHub repo URL (e.g. `https://github.com/you/claude-profiles`)
- A GitHub Personal Access Token (PAT) with `repo` scope
- A device name and profile name

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

### Switch atomicity

When switching profiles, your current state is snapshot and pushed to remote **before** overwriting `~/.claude`. If the push fails, `~/.claude` is not modified.

## Claude Code plugin

Install as a Claude Code plugin to use `/profile` slash commands:

```
/profile list
/profile switch work-laptop
/profile push
/profile pull
/profile status
```

## Configuration

Stored at `~/.claude-profile/config.json` (permissions: 600 on Unix):

```json
{
  "repoUrl": "https://github.com/you/claude-profiles",
  "token": "<GitHub PAT>",
  "deviceId": "home-desktop-win32",
  "activeProfile": "home-pc",
  "clonePath": "~/.claude-profile/repo"
}
```

The token is stored locally only and never committed to the sync repo.
