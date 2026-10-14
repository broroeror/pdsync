// Entry point: npm run pdsync -- <command>
// Commands that the desktop app uses take --json for machine-readable output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from './api.ts';
import { acquireLock, lockHolder } from './lock.ts';
import { finishRun, getMeta, Mirror, openState, setMeta, startRun, STATE_DIR } from './mirror.ts';
import { installService, serviceInfo, serviceStatus, uninstallService } from './service.ts';
import { AuthError, interactiveLogin, logout, machineLogin, openClient, savedUsername, UserError } from './session.ts';

const USAGE = `Usage: npm run pdsync -- <command>

  login               Log in once; the login is saved in your desktop keyring
  logout              Sign out and remove the saved login
  ls                  List the top level of My Files
  mirror [folder]     Download My Files into a folder (download-only: never
                      deletes or uploads). The folder is remembered after the
                      first run. Add --full to rescan everything.
  status              Login, folder, last run, automatic sync
  activity            Recent downloads, moves, removals and warnings
  review              Files the mirror skipped and why
  resolve <id> keep-local|keep-both
                      Decide about a skipped file (keep-both renames your local
                      file aside, then fetches the Drive version)
  config folder <dir> Mirror into a different folder from now on (the old
                      folder and its files are left as they are)
  service install [minutes]
                      Run the mirror automatically (default every 5 minutes)
  service status      Show when it runs next
  service uninstall   Stop running it automatically

Add --json to status, activity and review for machine-readable output.`;

/** The desktop app watches this file to know when to refresh. */
function notifyChanged() {
    fs.writeFileSync(path.join(STATE_DIR, 'changed'), String(Date.now()));
}

function checkFolder(folder: string) {
    if (folder === path.parse(folder).root || folder === os.homedir()) {
        throw new UserError(`Refusing to mirror straight into ${folder}; pick a dedicated folder.`);
    }
}

async function openMirror(db: DatabaseSync, folder: string) {
    const { client, username } = await openClient();
    const account = getMeta(db, 'account');
    if (account && account !== username) {
        throw new UserError(`This mirror belongs to ${account}. To mirror ${username}, choose a new folder first (config folder).`);
    }
    setMeta(db, 'account', username);
    return new Mirror(client, db, folder);
}

async function runMirror(db: DatabaseSync, given: string | undefined, full: boolean) {
    const folder = given ? path.resolve(given) : getMeta(db, 'root_dir');
    if (!folder) throw new UserError('First run: say which folder to mirror into, e.g.  npm run pdsync -- mirror ~/DriveMirror');
    checkFolder(folder);
    acquireLock(STATE_DIR);

    const runId = startRun(db);
    notifyChanged();
    let mirror: Mirror | undefined;
    try {
        mirror = await openMirror(db, folder);
        await mirror.run({ full });
    } catch (error) {
        const auth = error instanceof AuthError || (error instanceof ApiError && error.status === 401);
        finishRun(db, runId, {
            downloaded: mirror?.downloaded ?? 0,
            skipped: mirror?.skipped ?? 0,
            failures: (mirror?.failures ?? 0) + 1,
            errorKind: auth ? 'auth' : 'other',
            error: error instanceof Error ? error.message : String(error),
        });
        notifyChanged();
        throw error;
    }
    finishRun(db, runId, mirror);
    notifyChanged();

    const parts = [`${mirror.downloaded} downloaded`];
    if (mirror.skipped) parts.push(`${mirror.skipped} skipped (see: review)`);
    if (mirror.failures) parts.push(`${mirror.failures} failed; they will be retried next run`);
    console.log(`\nMirror at ${folder}: ${parts.join(', ')}.`);
    if (mirror.failures) process.exitCode = 1;
}

async function status(db: DatabaseSync) {
    const lastRun = db.prepare('SELECT * FROM runs WHERE finished_ms IS NOT NULL ORDER BY id DESC LIMIT 1').get() as any;
    const reviewCount = (db.prepare('SELECT COUNT(*) AS n FROM review WHERE dismissed = 0').get() as any).n;
    return {
        username: await savedUsername(),
        folder: getMeta(db, 'root_dir') ?? null,
        firstSyncDone: !!getMeta(db, 'event_id'),
        running: lockHolder(STATE_DIR) !== null,
        lastRun: lastRun
            ? {
                  finishedMs: lastRun.finished_ms,
                  downloaded: lastRun.downloaded,
                  skipped: lastRun.skipped,
                  failures: lastRun.failures,
                  errorKind: lastRun.error_kind,
                  error: lastRun.error,
              }
            : null,
        reviewCount,
        service: serviceInfo(),
    };
}

async function main(command: string | undefined, args: string[]) {
    const json = args.includes('--json');
    const positional = args.filter((a) => !a.startsWith('--'));

    switch (command) {
        case 'login':
            if (json) return machineLogin().finally(() => fs.existsSync(STATE_DIR) && notifyChanged());
            await interactiveLogin();
            if (fs.existsSync(STATE_DIR)) notifyChanged();
            return;
        case 'logout':
            await logout();
            if (fs.existsSync(STATE_DIR)) notifyChanged();
            return;
        case 'ls': {
            const { client } = await openClient();
            const root = await client.getMyFilesRootFolder();
            for await (const node of client.iterateFolderChildren(root)) {
                const name = node.name.ok ? node.name.value : '<name could not be decrypted>';
                console.log(`${node.type === 'folder' ? '[dir] ' : '      '}${name}`);
            }
            return;
        }
        case 'mirror':
            return runMirror(openState(), positional[0], args.includes('--full'));
        case 'status': {
            const s = await status(openState());
            if (json) return console.log(JSON.stringify(s));
            console.log(`Logged in:   ${s.username ?? 'no'}`);
            console.log(`Folder:      ${s.folder ?? 'not chosen yet'}`);
            console.log(`Running now: ${s.running ? 'yes' : 'no'}`);
            if (s.lastRun) {
                const r = s.lastRun;
                console.log(
                    `Last run:    ${new Date(r.finishedMs).toLocaleString()}, ${r.error ? `failed: ${r.error}` : `${r.downloaded} downloaded, ${r.skipped} skipped, ${r.failures} failed`}`,
                );
            }
            if (s.reviewCount) console.log(`To review:   ${s.reviewCount} skipped file(s) (see: review)`);
            console.log(`Automatic:   ${s.service.enabled ? `every ${s.service.intervalMinutes} min` : 'off'}`);
            return;
        }
        case 'activity': {
            const limit = Number(args[args.indexOf('--limit') + 1]) || 100;
            const rows = openState().prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit) as any[];
            if (json) return console.log(JSON.stringify(rows.map((r) => ({ timeMs: r.time_ms, kind: r.kind, path: r.path, detail: r.detail }))));
            for (const r of rows.reverse()) {
                console.log(`${new Date(r.time_ms).toLocaleString()}  ${r.kind.padEnd(8)} ${r.path}${r.detail ? `  (${r.detail})` : ''}`);
            }
            return;
        }
        case 'review': {
            const rows = openState().prepare('SELECT * FROM review WHERE dismissed = 0 ORDER BY time_ms').all() as any[];
            if (json) return console.log(JSON.stringify(rows.map((r) => ({ id: r.uid, path: r.rel_path, reason: r.reason, timeMs: r.time_ms }))));
            if (!rows.length) return console.log('Nothing to review.');
            for (const r of rows) {
                console.log(`${r.rel_path}\n  ${r.reason === 'local-edit' ? 'Edited locally and changed on Drive' : 'A local file with this name already existed'}\n  id: ${r.uid}`);
            }
            return;
        }
        case 'resolve': {
            const [uid, action] = positional;
            if (!uid || (action !== 'keep-local' && action !== 'keep-both')) {
                throw new UserError('Usage: npm run pdsync -- resolve <id> keep-local|keep-both');
            }
            const db = openState();
            const folder = getMeta(db, 'root_dir');
            if (!folder) throw new UserError('No mirror folder yet.');
            acquireLock(STATE_DIR);
            try {
                await (await openMirror(db, folder)).resolve(uid, action);
            } finally {
                notifyChanged();
            }
            return;
        }
        case 'config': {
            const [key, value] = positional;
            if (key !== 'folder' || !value) throw new UserError('Usage: npm run pdsync -- config folder <dir>');
            const db = openState();
            const folder = path.resolve(value);
            checkFolder(folder);
            if (folder === getMeta(db, 'root_dir')) return console.log(`Already mirroring into ${folder}.`);
            acquireLock(STATE_DIR);
            // Start the new mirror from scratch; nothing on disk is touched.
            db.exec("DELETE FROM nodes; DELETE FROM review; DELETE FROM meta WHERE key IN ('event_id', 'scope', 'account');");
            setMeta(db, 'root_dir', folder);
            notifyChanged();
            console.log(`From the next run, My Files is mirrored into ${folder}.`);
            return;
        }
        case 'service': {
            const [action, minutes] = positional;
            if (action === 'status') return serviceStatus();
            if (action === 'install') installService(openState(), minutes ? Number(minutes) : undefined);
            else if (action === 'uninstall') uninstallService();
            else throw new UserError('Usage: npm run pdsync -- service install|status|uninstall');
            return notifyChanged();
        }
        default:
            console.log(USAGE);
            if (command && command !== 'help') process.exitCode = 1;
    }
}

const [command, ...args] = process.argv.slice(2);
try {
    await main(command, args);
} catch (error) {
    if (error instanceof UserError) {
        console.error(error.message);
    } else if (error instanceof ApiError) {
        console.error(`API error: HTTP ${error.status}, code ${error.code}: ${error.message}`);
    } else {
        console.error(error);
    }
    process.exitCode = 1;
}
