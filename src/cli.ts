// Entry point: npm run pdsync -- <command>
// Commands that the desktop app uses take --json for machine-readable output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from './api.ts';
import { acquireLock, lockHolder } from './lock.ts';
import { randomUUID } from 'node:crypto';
import { finishRun, getMeta, kindOf, Mirror, openState, setMeta, startRun, STATE_DIR, type UploadKind } from './mirror.ts';
import { ask } from './prompt.ts';
import { planUploads, type Plan } from './plan.ts';
import { describeTrash, prepareTrashFolder, trashTarget } from './trash.ts';
import { installService, serviceInfo, serviceStatus, uninstallService } from './service.ts';
import { AuthError, interactiveLogin, logout, machineLogin, openClient, savedUsername, UserError } from './session.ts';

const USAGE = `Usage: npm run pdsync -- <command>

  login               Log in once; the login is saved in your desktop keyring
  logout              Sign out and remove the saved login
  ls                  List the top level of My Files
  mirror [folder]     Download My Files into a folder (download-only: never
                      deletes or uploads). The folder is remembered after the
                      first run. Add --full to rescan everything.
  plan                Dry run of uploading: sync with Drive, then list what
                      would change on Drive. Changes nothing on Drive.
  push <kinds> [--yes]
                      Upload now, after showing what and asking (kinds: new)
  config uploads <kinds>|none
                      Which kinds of local change automatic runs upload
                      (off until you switch them on)
  status              Login, folder, last run, automatic sync
  activity            Recent downloads, moves, removals and warnings
  review              Files the mirror skipped and why
  resolve <id> keep-local|keep-both
                      Decide about a skipped file (keep-both renames your local
                      file aside, then fetches the Drive version)
  config folder <dir> Mirror into a different folder from now on (the old
                      folder and its files are left as they are)
  config trash desktop|<dir>
                      Where your copy goes when a file is deleted on Drive:
                      the desktop trash (default) or a folder you choose
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

const UPLOAD_KINDS: UploadKind[] = ['new', 'edits', 'moves', 'deletes'];
// Built so far; the rest are refused until they exist.
const AVAILABLE_KINDS = new Set<UploadKind>(['new']);

/** Upload kinds switched on for automatic runs. */
function enabledKinds(db: DatabaseSync) {
    return new Set((getMeta(db, 'uploads') ?? '').split(',').filter((k): k is UploadKind => AVAILABLE_KINDS.has(k as UploadKind)));
}

function parseKinds(words: string[]) {
    const kinds = new Set<UploadKind>();
    for (const w of words) {
        if (w === 'all') AVAILABLE_KINDS.forEach((k) => kinds.add(k));
        else if (!UPLOAD_KINDS.includes(w as UploadKind)) throw new UserError(`Unknown kind "${w}" (use: ${UPLOAD_KINDS.join(', ')})`);
        else if (!AVAILABLE_KINDS.has(w as UploadKind)) throw new UserError(`Uploading "${w}" isn't built yet (available: ${[...AVAILABLE_KINDS].join(', ')})`);
        else kinds.add(w as UploadKind);
    }
    return kinds;
}

async function openMirror(db: DatabaseSync, folder: string) {
    let clientUid = getMeta(db, 'client_uid');
    if (!clientUid) setMeta(db, 'client_uid', (clientUid = randomUUID()));
    const { client, username } = await openClient(clientUid);
    const account = getMeta(db, 'account');
    if (account && account !== username) {
        throw new UserError(`This mirror belongs to ${account}. To mirror ${username}, choose a new folder first (config folder).`);
    }
    setMeta(db, 'account', username);
    return new Mirror(client, db, folder);
}

async function runMirror(
    db: DatabaseSync,
    given: string | undefined,
    full: boolean,
    // Upload kinds to carry out after catching up; default: those switched on.
    // `confirm` sees the items first and may cancel.
    upload: { kinds?: Set<UploadKind>; confirm?: (items: Plan['items']) => Promise<boolean> } = {},
) {
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
        const kinds = upload.kinds ?? enabledKinds(db);
        if (kinds.size && !mirror.failures) {
            const plan = await planUploads(db, folder);
            if (plan.blocked) console.log(plan.blocked);
            const items = plan.items.filter((i) => kinds.has(kindOf(i)));
            if (items.length && (!upload.confirm || (await upload.confirm(items)))) {
                await mirror.applyPlan(plan, kinds);
            }
        }
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
    if (mirror.uploaded) parts.push(`${mirror.uploaded} uploaded`);
    if (mirror.trashed) parts.push(`${mirror.trashed} moved to trash (deleted on Drive)`);
    if (mirror.skipped) parts.push(`${mirror.skipped} skipped (see: review)`);
    if (mirror.failures) parts.push(`${mirror.failures} failed; they will be retried next run`);
    console.log(`\nMirror at ${folder}: ${parts.join(', ')}.`);
    if (mirror.failures) process.exitCode = 1;
}

function printPlan(plan: Plan, verb: 'Would' | 'Will' = 'Would') {
    if (plan.blocked) return console.log(`\n${plan.blocked}`);
    const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
    const groups: [string, string[]][] = [
        [`${verb} create on Drive`, plan.items.flatMap((i) => (i.action === 'create-folder' ? [`+ ${i.rel}/`] : []))],
        [`${verb} rename or move on Drive`, plan.items.flatMap((i) => (i.action === 'move' ? [`→ ${i.from}  →  ${i.to}`] : []))],
        [`${verb} upload (new)`, plan.items.flatMap((i) => (i.action === 'upload' ? [`+ ${i.rel}  (${size(i.size)})`] : []))],
        [`${verb} upload a new version (edited here)`, plan.items.flatMap((i) => (i.action === 'update' ? [`~ ${i.rel}  (${size(i.size)})`] : []))],
        [
            `${verb} move to Drive's trash (recoverable)`,
            plan.items.flatMap((i) => (i.action === 'trash' ? [`✕ ${i.rel}${i.type === 'folder' ? `/  (${i.files} files)` : ''}`] : [])),
        ],
        ['Held back', plan.held.map((h) => `· ${h.rel ? `${h.rel}: ` : ''}${h.why}`)],
    ];
    console.log('');
    if (!plan.items.length && !plan.held.length) return console.log('Nothing to upload: Drive already matches your folder.');
    for (const [title, lines] of groups) {
        if (!lines.length) continue;
        console.log(`${title}:`);
        for (const line of lines) console.log(`  ${line}`);
    }
    if (verb === 'Would') console.log('\nThis was a dry run: nothing was changed on Drive.');
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
        trash: trashTarget(db),
        uploads: [...enabledKinds(db)],
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
        case 'push': {
            const kinds = parseKinds(positional);
            if (!kinds.size) throw new UserError('Say what to upload, e.g.  push new');
            const db = openState();
            return runMirror(db, undefined, false, {
                kinds,
                confirm: async (items) => {
                    printPlan({ items, held: [] }, 'Will');
                    if (args.includes('--yes')) return true;
                    const answer = await ask(`\nUpload ${items.length === 1 ? 'this' : `these ${items.length} items`} to Drive? [y/N] `);
                    if (/^y(es)?$/i.test(answer)) return true;
                    console.log('Cancelled; nothing was changed on Drive.');
                    return false;
                },
            });
        }
        case 'plan': {
            const db = openState();
            // Catch up with Drive first, so conflicts are already in Review.
            await runMirror(db, undefined, false);
            const plan = await planUploads(db, getMeta(db, 'root_dir')!);
            if (json) return console.log(JSON.stringify(plan));
            return printPlan(plan);
        }
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
            console.log(`Drive deletes go to: ${describeTrash(s.trash)}`);
            console.log(`Uploads:     ${s.uploads.length ? s.uploads.join(', ') : 'off (download only)'}`);
            console.log(`Automatic:   ${s.service.enabled ? (s.service.intervalMinutes ? `every ${s.service.intervalMinutes} min` : 'on') : 'off'}`);
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
            const db = openState();
            const query = () => db.prepare('SELECT * FROM review WHERE dismissed = 0 ORDER BY time_ms').all() as any[];
            let rows = query();
            const folder = getMeta(db, 'root_dir');
            if (folder && rows.some((r) => r.drive_mtime_ms === null)) {
                // Older items lack the Drive version's details: look them up once.
                try {
                    await (await openMirror(db, folder)).fillReviewDetails();
                    rows = query();
                } catch {
                    // Offline or logged out: show what we have.
                }
            }
            const items = rows.map((r) => {
                let local: { mtimeMs: number; size: number } | null = null;
                try {
                    const stat = fs.statSync(path.join(folder ?? '', r.rel_path));
                    local = { mtimeMs: Math.trunc(stat.mtimeMs), size: stat.size };
                } catch {
                    // The local file was moved or deleted since.
                }
                const drive = r.drive_mtime_ms === null ? null : { mtimeMs: r.drive_mtime_ms, size: r.drive_size };
                return { id: r.uid, path: r.rel_path, reason: r.reason, timeMs: r.time_ms, local, drive };
            });
            if (json) return console.log(JSON.stringify(items));
            if (!items.length) return console.log('Nothing to review.');
            const describe = (side: { mtimeMs: number; size: number | null } | null) =>
                side ? `modified ${new Date(side.mtimeMs).toLocaleString()}${side.size !== null ? `, ${side.size} bytes` : ''}` : 'unknown';
            for (const item of items) {
                console.log(item.path);
                console.log(`  ${item.reason === 'local-edit' ? 'Changed both here and on Drive' : 'Same name as a Drive file, but not created by sync'}`);
                console.log(`  This computer: ${item.local ? describe(item.local) : 'missing'}`);
                console.log(`  Drive:         ${describe(item.drive)}`);
                console.log(`  id: ${item.id}`);
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
            const db = openState();
            if (key === 'uploads' && value) {
                const kinds = value === 'none' ? new Set<UploadKind>() : parseKinds(positional.slice(1));
                setMeta(db, 'uploads', [...kinds].join(','));
                notifyChanged();
                return console.log(kinds.size ? `Automatic runs now upload: ${[...kinds].join(', ')}.` : 'Automatic runs upload nothing (download only).');
            }
            if (key === 'trash' && value) {
                if (value === 'desktop') {
                    db.prepare("DELETE FROM meta WHERE key = 'trash'").run();
                } else {
                    let dir;
                    try {
                        dir = await prepareTrashFolder(value, getMeta(db, 'root_dir'));
                    } catch (error) {
                        throw new UserError((error as Error).message);
                    }
                    setMeta(db, 'trash', dir);
                }
                notifyChanged();
                return console.log(`Files deleted on Drive now go to ${describeTrash(trashTarget(db))}.`);
            }
            if (key !== 'folder' || !value) throw new UserError('Usage: npm run pdsync -- config folder <dir> | config trash desktop|<dir>');
            const folder = path.resolve(value);
            checkFolder(folder);
            if (folder === getMeta(db, 'root_dir')) return console.log(`Already mirroring into ${folder}.`);
            acquireLock(STATE_DIR);
            // Start the new mirror from scratch; nothing on disk is touched.
            db.exec("DELETE FROM nodes; DELETE FROM review; DELETE FROM leftovers; DELETE FROM meta WHERE key IN ('event_id', 'scope', 'account', 'layout');");
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
