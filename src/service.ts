// Installs a systemd *user* timer that runs `mirror` periodically: runs as
// the user, only while they're logged in, no root, logs to the journal.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { getMeta } from './mirror.ts';
import { UserError } from './session.ts';

const UNIT = 'pdsync-mirror';
const UNIT_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd/user');
const PROJECT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_INTERVAL_MINUTES = 5;

function systemctl(...args: string[]) {
    return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The `node` found on PATH (e.g. a ~/.local/bin symlink) if it is this same
 * node, so the unit survives Node upgrades; process.execPath would pin the
 * versioned install directory.
 */
function nodePath() {
    const real = fs.realpathSync(process.execPath);
    for (const dir of (process.env.PATH ?? '').split(':')) {
        const candidate = path.join(dir, 'node');
        try {
            if (path.isAbsolute(candidate) && fs.realpathSync(candidate) === real) return candidate;
        } catch {
            // Not in this directory.
        }
    }
    return process.execPath;
}

/** Quote one argument for an ExecStart= line. */
function quote(arg: string) {
    return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function installService(db: DatabaseSync, intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
    if (!getMeta(db, 'root_dir') || !getMeta(db, 'event_id')) {
        throw new UserError('Run a mirror by hand first (npm run pdsync -- mirror <folder>), so the folder is known.');
    }
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) {
        throw new UserError('The interval must be a whole number of minutes, at least 1.');
    }

    // Absolute node path: user-local installs (~/.local/bin) aren't on systemd's PATH.
    const exec = [nodePath(), '--import', 'tsx', '--import', './src/preload.ts', 'src/cli.ts', 'mirror'];

    const service = `[Unit]
Description=Download-only Drive mirror (third-party, not supported by Proton)

[Service]
Type=oneshot
WorkingDirectory=${PROJECT_DIR}
ExecStart=${exec.map(quote).join(' ')}
Nice=10
IOSchedulingClass=idle
`;
    const timer = `[Unit]
Description=Run the Drive mirror every ${intervalMinutes} minutes

[Timer]
OnStartupSec=2min
OnUnitActiveSec=${intervalMinutes}min

[Install]
WantedBy=timers.target
`;
    fs.mkdirSync(UNIT_DIR, { recursive: true });
    fs.writeFileSync(path.join(UNIT_DIR, `${UNIT}.service`), service);
    fs.writeFileSync(path.join(UNIT_DIR, `${UNIT}.timer`), timer);
    systemctl('daemon-reload');
    systemctl('enable', '--now', `${UNIT}.timer`);
    console.log(`Installed. The mirror now runs every ${intervalMinutes} minutes while you're logged in.`);
    console.log(`  Status:  npm run pdsync -- service status`);
    console.log(`  Log:     journalctl --user -u ${UNIT}`);
    console.log(`  Remove:  npm run pdsync -- service uninstall`);
}

export function uninstallService() {
    try {
        systemctl('disable', '--now', `${UNIT}.timer`);
    } catch {
        // Not installed or already disabled; still remove any files below.
    }
    for (const ext of ['service', 'timer']) fs.rmSync(path.join(UNIT_DIR, `${UNIT}.${ext}`), { force: true });
    systemctl('daemon-reload');
    console.log('Removed. The mirror no longer runs automatically; your mirrored files are untouched.');
}

/** Next trigger time. Our timer is interval-based (monotonic), so the wall-clock
 *  time comes from list-timers rather than the unit's realtime property. */
function nextRun() {
    try {
        const [entry] = JSON.parse(systemctl('list-timers', `${UNIT}.timer`, '--output=json', '--no-pager'));
        return entry?.next ? new Date(entry.next / 1000).toLocaleString() : 'n/a';
    } catch {
        return 'n/a';
    }
}

export function serviceStatus() {
    const show = (unit: string, props: string) => {
        try {
            return systemctl('show', unit, `--property=${props}`, '--timestamp=pretty');
        } catch {
            return '';
        }
    };
    const timer = show(`${UNIT}.timer`, 'ActiveState,LastTriggerUSec');
    if (!timer.includes('ActiveState=active')) {
        console.log('Not running automatically. Set it up with: npm run pdsync -- service install');
        return;
    }
    const svc = show(`${UNIT}.service`, 'Result,ExecMainExitTimestamp');
    const get = (text: string, key: string) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] || 'n/a';
    console.log(`Automatic mirror: on`);
    console.log(`  Last run:   ${get(timer, 'LastTriggerUSec')} (${get(svc, 'Result')})`);
    console.log(`  Next run:   ${nextRun()}`);
    console.log(`  Log:        journalctl --user -u ${UNIT}`);
}
