// Runs `mirror` periodically through a systemd *user* timer: as the user,
// only while they're logged in, no root, logs to the journal.
//
// Installed package: the units ship in /usr/lib/systemd/user and the chosen
// interval is a per-user drop-in. From source: full units are written to
// ~/.config/systemd/user, pointing at this checkout.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { UserError } from './session.ts';

// Defined by the bundler for the installed build.
declare const PDSYNC_PACKAGED: boolean | undefined;
const PACKAGED = typeof PDSYNC_PACKAGED !== 'undefined' && PDSYNC_PACKAGED;

const UNIT = 'pdsync-mirror';
const UNIT_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd/user');
const DROP_IN = path.join(UNIT_DIR, `${UNIT}.timer.d`, 'interval.conf');
const PACKAGED_TIMER = `/usr/lib/systemd/user/${UNIT}.timer`;
// Marks unit files we wrote ourselves (so we only ever delete our own).
const DESCRIPTION = 'Download-only Drive mirror (third-party, not supported by Proton)';
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

/** Remove units written by a from-source install, which would shadow the packaged ones. */
function removeOwnUserUnits() {
    for (const ext of ['service', 'timer']) {
        const file = path.join(UNIT_DIR, `${UNIT}.${ext}`);
        try {
            const text = fs.readFileSync(file, 'utf8');
            if (text.includes(DESCRIPTION) || text.includes('Run the Drive mirror every')) fs.rmSync(file);
        } catch {
            // Not there.
        }
    }
}

function writeSourceUnits(intervalMinutes: number) {
    const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    // Absolute node path: user-local installs (~/.local/bin) aren't on systemd's PATH.
    const exec = [nodePath(), '--import', 'tsx', '--import', './src/preload.ts', 'src/cli.ts', 'mirror'];
    fs.mkdirSync(UNIT_DIR, { recursive: true });
    fs.writeFileSync(
        path.join(UNIT_DIR, `${UNIT}.service`),
        `[Unit]\nDescription=${DESCRIPTION}\n\n[Service]\nType=oneshot\nWorkingDirectory=${projectDir}\n` +
            `ExecStart=${exec.map(quote).join(' ')}\nNice=10\nIOSchedulingClass=idle\n`,
    );
    fs.writeFileSync(
        path.join(UNIT_DIR, `${UNIT}.timer`),
        `[Unit]\nDescription=Run the Drive mirror every ${intervalMinutes} minutes\n\n[Timer]\nOnStartupSec=2min\n` +
            `OnUnitActiveSec=${intervalMinutes}min\n\n[Install]\nWantedBy=timers.target\n`,
    );
}

export function installService(db: DatabaseSync, intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) {
        throw new UserError('The interval must be a whole number of minutes, at least 1.');
    }

    if (PACKAGED) {
        removeOwnUserUnits();
        fs.mkdirSync(path.dirname(DROP_IN), { recursive: true });
        // An empty assignment clears the packaged interval before setting ours.
        fs.writeFileSync(DROP_IN, `[Timer]\nOnUnitActiveSec=\nOnUnitActiveSec=${intervalMinutes}min\n`);
    } else {
        writeSourceUnits(intervalMinutes);
    }
    systemctl('daemon-reload');
    systemctl('enable', `${UNIT}.timer`);
    // Restart so a changed interval takes effect now.
    systemctl('restart', `${UNIT}.timer`);
    console.log(`Automatic sync is on: every ${intervalMinutes} minutes while you're logged in.`);
    console.log(`  Log:  journalctl --user -u ${UNIT}`);
}

export function uninstallService() {
    try {
        systemctl('disable', '--now', `${UNIT}.timer`);
    } catch {
        // Not installed or already disabled; still remove any files below.
    }
    fs.rmSync(DROP_IN, { force: true });
    if (!PACKAGED) removeOwnUserUnits();
    systemctl('daemon-reload');
    console.log('Automatic sync is off; your mirrored files are untouched.');
}

function intervalIn(file: string): number | null {
    try {
        const matches = [...fs.readFileSync(file, 'utf8').matchAll(/^OnUnitActiveSec=(\d+)min$/gm)];
        return matches.length ? Number(matches.at(-1)![1]) : null;
    } catch {
        return null;
    }
}

/** Next trigger time. Our timer is interval-based (monotonic), so the wall-clock
 *  time comes from list-timers rather than the unit's realtime property. */
function nextRunMs(): number | null {
    try {
        const [entry] = JSON.parse(systemctl('list-timers', `${UNIT}.timer`, '--output=json', '--no-pager'));
        return entry?.next ? Math.round(entry.next / 1000) : null;
    } catch {
        return null;
    }
}

export type ServiceInfo = { enabled: boolean; intervalMinutes: number | null; nextRunMs: number | null };

export function serviceInfo(): ServiceInfo {
    let enabled = false;
    try {
        enabled = systemctl('is-active', `${UNIT}.timer`).trim() === 'active';
    } catch {
        // is-active exits non-zero when inactive.
    }
    // Most specific first: per-user drop-in, a from-source unit, the packaged unit.
    const intervalMinutes =
        intervalIn(DROP_IN) ?? intervalIn(path.join(UNIT_DIR, `${UNIT}.timer`)) ?? intervalIn(PACKAGED_TIMER);
    return { enabled, intervalMinutes, nextRunMs: enabled ? nextRunMs() : null };
}

export function serviceStatus() {
    const info = serviceInfo();
    if (!info.enabled) {
        console.log('Not running automatically. Set it up with: npm run pdsync -- service install');
        return;
    }
    console.log(`Automatic mirror: on${info.intervalMinutes ? `, every ${info.intervalMinutes} minutes` : ''}`);
    console.log(`  Next run:   ${info.nextRunMs ? new Date(info.nextRunMs).toLocaleString() : 'n/a'}`);
    console.log(`  Log:        journalctl --user -u ${UNIT}`);
}
