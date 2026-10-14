# pdsync

**Unofficial** two-way sync client for Proton Drive on Linux, built on Proton's
official [Drive SDK](https://github.com/ProtonDriveApps/sdk).

> This is a third-party application not officially supported by Proton.
> "pdsync" is a working name. Status: alpha, personal use.

## What it does

- Syncs **My Files** with a local folder, and any number of **folders from this
  computer**, which appear on Drive under *Computers → (this PC)*, the same way
  Proton's Windows and Mac apps do it.
- Two-way: downloads changes from Drive; uploads new files, edits (as new
  versions), renames/moves and deletions. Each kind of upload is switched on
  separately and is **off by default**.
- Proton Docs/Sheets become `.desktop` shortcuts that open them in the browser.
- A PySide6/QML desktop app with a tray icon: status, activity, a Review list
  for conflicts (*Keep mine* / *Keep both*), and settings.
- Runs on a systemd **user** timer (default every 5 minutes).

## Safety rules

- Nothing is ever deleted outright: Drive deletions move the local copy to the
  desktop trash or a chosen folder; local deletions go to Drive's trash.
- A file changed on both sides goes to **Review**; neither side is overwritten.
  Before uploading an edit, Drive is re-checked for a newer version.
- Many deletions at once are held until confirmed (or undone).
- If a synced folder is missing or empty (e.g. an unmounted drive), nothing is
  changed on Drive.
- A trash folder is never created implicitly (an unmounted drive's mount point
  is an empty folder on the system disk).

## Layout

| Path | What |
|---|---|
| `src/` | Engine (TypeScript): SRP login, keyring session, sync (`mirror.ts`), upload planner (`plan.ts`), folder pairs (`pairs.ts`), trash, systemd service, CLI (`cli.ts`) |
| `gui/pdsync_gui/` | Desktop app (PySide6 + QML); it only talks to the engine CLI (`--json`) |
| `test/` | Offline tests against a fake Drive (no account needed) |
| `packaging/` | Arch `PKGBUILD`, launchers, systemd user units, desktop entry |
| `build.mjs` | Bundles the engine into one file (`dist/pdsync.mjs`) |

State lives in `~/.local/state/pdsync/`. The login (session + derived key
password, never the account password) is stored in the desktop keyring via
Secret Service (`secret-tool`).

## Develop

Requires Node.js 24+, npm, Python 3 with PySide6, and libsecret.

```sh
npm ci --ignore-scripts
npm test                      # offline tests
bin/pdsync login              # third-party notice, then email + password
bin/pdsync folders add ~/SomeFolder
bin/pdsync plan               # dry run: what would change on Drive
bin/pdsync push new           # upload new files (asks first)
bin/pdsync-gui                # desktop app from source
```

`bin/pdsync` with no arguments lists every command.

Node traps solved in `src/preload.ts` (development) and `build.mjs` (bundle):
`@protontech/crypto` imports the browser-only `openpgp/lightweight` (redirected
to `openpgp`), and needs `@protontech/crypto/polyfill` on Node.

## Install (Arch)

```sh
cd packaging && makepkg -si
pdsync service install        # automatic sync (systemd user timer)
```

## Proton's SDK usage terms

Personal, non-commercial use; requests only go to Proton's official domain;
honest `x-pm-appversion` header (`external-drive-pdsync@<version>-alpha`);
Drive events instead of polling; no Proton branding; the third-party notice is
shown wherever credentials are asked for.

## License

GPL-3.0-or-later (required by `@protontech/crypto`). Bundled third-party
licences are collected into `THIRD-PARTY-LICENSES.txt` at build time.
