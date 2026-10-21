# pdsync

An **unofficial** sync client for Proton Drive on Linux: a tray app that keeps
your Drive and folders on your computer in sync.

> **This is a third-party application, not made or supported by Proton.**
> It's a hobby project in **alpha**: please keep your own backup of anything
> important while you try it. Built on Proton's official open-source
> [Drive SDK](https://github.com/ProtonDriveApps/sdk).

## What it does

- **My Files on your computer:** your Drive's My Files, synced into a folder you
  choose.
- **Folders from this computer:** add any folder (e.g. `~/Documents`) and it's
  synced to Drive under *Computers → (your PC's name)*, like Proton's Windows and
  Mac apps.
- **Two-way, with you in control:** downloads always; uploads (new files, edits,
  renames/moves, deletions) are each switched on separately, generally or per
  folder. **Everything is off until you tick it**, so it starts as a safe,
  download-only mirror.
- **A tray app:** status, recent activity, a Review list for anything that
  changed on both sides, and settings. Syncs every few minutes in the
  background, with a Stop button.

## Safety rules

- **Nothing is ever deleted outright.** Deleted on Drive → your copy goes to the
  desktop trash (or a folder you choose); deleted here → Drive's trash.
- **Changed on both sides?** Neither side is overwritten; it goes to Review
  (*Keep mine* / *Keep both*). Drive also keeps old versions of every file.
- **Many deletions at once** are held until you confirm (or undo) them.
- **A missing or empty folder** (e.g. an unplugged drive) never causes deletions.
- **Drive full?** Only what fits is uploaded; you're told once, and uploads
  resume by themselves when there's space.
- **Proton Docs/Sheets** appear as shortcuts that open them in the browser; they
  are never uploaded over.
- `node_modules`, `.git`, caches and similar are skipped by default (editable
  per folder).

## Install (Arch Linux)

```sh
yay -S pdsync
```

Then open **pdsync** from your app menu, log in, and choose what to sync.
Automatic syncing in the background:

```sh
pdsync service install      # every 5 minutes while you're logged in
```

## Good to know

- **Use your Proton username**, or the email you signed up with if your account
  was made with another email (like Gmail). 2FA with an authenticator app is
  supported; security keys (FIDO) alone are not yet.
- **VPNs** make Proton ask for a human-verification check much more often. The
  app handles the check, but logging in with the VPN off usually avoids it.
- Your login is kept in the desktop keyring (via Secret Service); your password
  itself is never stored.
- **Proton is planning a change to Drive's encryption** (expected around the end
  of 2026 / early 2027). Until pdsync is updated for it, syncing will stop
  working; your files stay safe where they are. Keep it up to date.
- Proton allows personal, non-commercial use of its SDK; this project follows
  their [guidelines](https://github.com/ProtonDriveApps/sdk#usage-guidelines-for-personal-projects)
  (honest app identification, event-based sync, no Proton branding).

## Command line

Everything the app does is also a command (`pdsync` with no arguments lists
them all), e.g.:

```sh
pdsync status               # login, folders, last sync, storage
pdsync plan                 # dry run: what would change on Drive
pdsync folders add ~/Notes  # sync a folder from this computer
pdsync stop                 # stop a running sync safely
```

## Develop

Requires Node.js 22+, npm, Python 3 with PySide6, libsecret and glib2.

```sh
npm ci --ignore-scripts
npm test                    # offline tests against a fake Drive (no account needed)
bin/pdsync <command>        # the engine from source
bin/pdsync-gui              # the app from source
```

| Path | What |
|---|---|
| `src/` | Engine (TypeScript): login, sync (`mirror.ts`), upload planner (`plan.ts`), folder pairs (`pairs.ts`), trash, systemd service, CLI (`cli.ts`) |
| `gui/pdsync_gui/` | Desktop app (PySide6 + QML); it only talks to the engine (`--json`) |
| `test/` | Offline tests |
| `tools/` | Headless screenshots and UI checks (made-up data) |
| `packaging/` | PKGBUILDs (local build, and the AUR release in `aur/`), launchers, systemd units |

## License

GPL-3.0-or-later (required by `@protontech/crypto`). Not affiliated with,
endorsed by, or supported by Proton AG. "Proton" and "Proton Drive" are
trademarks of Proton AG.
