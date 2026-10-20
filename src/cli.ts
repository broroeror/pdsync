// Entry point: npm run pdsync -- <command>
// Commands that the desktop app uses take --json for machine-readable output.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { ApiError } from './api.ts';
import { acquireLock, lockHolder } from './lock.ts';
import { addActivity, finishRun, getMeta, Mirror, openState, requestStop, setMeta, SpaceBudget, startRun, STATE_DIR, stopRequested, StopRequested, type UploadKind } from './mirror.ts';
import type { Api } from './api.ts';
import { DEFAULT_EXCLUDES, excludeSettings, makeExcluder, saveExcludeSettings } from './exclude.ts';
import { addPair, checkNewLocal, listPairs, removePair, startFreshForNewAccount, type Pair } from './pairs.ts';
import { planForKinds, planUploads, type Plan } from './plan.ts';
import { ask } from './prompt.ts';
import { installService, serviceInfo, serviceStatus, uninstallService } from './service.ts';
import { AuthError, interactiveLogin, logout, machineLogin, openClient, savedUsername, UserError } from './session.ts';
import { describeTrash, prepareTrashFolder, trashTarget } from './trash.ts';

const USAGE = `Usage: npm run pdsync -- <command>

  login               Log in once; the login is saved in your desktop keyring
  logout              Sign out and remove the saved login
  ls                  List the top level of My Files
  mirror [folder]     Sync every folder pair: catch up with Drive, then upload
                      the kinds of local change switched on (config uploads).
                      [folder] sets My Files' local folder on first run.
                      Add --full to rescan everything.
  folders             List synced folders
  folders add <dir>   Sync a folder from this computer (it appears under
                      Computers on Drive)
  folders remove <dir|id>
                      Stop syncing a folder (its files stay, here and on Drive)
  folders measure <dir>
                      How many files/bytes a folder has, before and after the
                      default exclusions (node_modules, .git, caches, ...)
  folders excludes <dir|id> [--defaults on|off] [--set <pattern>...]
                      Show or change what a folder never syncs
  stop                Stop a sync in progress safely (finishes or cancels the
                      current step; the next sync carries on)
  plan                Dry run of uploading: sync with Drive, then list what
                      would change on Drive. Changes nothing on Drive.
  push <kinds> [--yes]
                      Upload now, after showing what and asking (kinds: new,
                      edits, moves, deletes, all). --allow-many confirms a
                      held mass deletion.
  restore-deleted     Download again the files whose mass deletion was held
  status              Login, folders, last run, automatic sync
  activity            Recent downloads, uploads, moves, removals and warnings
  review              Files sync skipped and why
  resolve <id> keep-local|keep-both
                      Decide about a skipped file (keep-both renames your local
                      file aside, then fetches the Drive version)
  config folder <dir> Mirror My Files into a different folder from now on
                      (the old folder and its files are left as they are)
  config uploads <kinds>|none
                      Which kinds of local change automatic runs upload
                      (off until you switch them on)
  config trash desktop|<dir>
                      Where your copy goes when a file is deleted on Drive:
                      the desktop trash (default) or a folder you choose
  service install [minutes]
                      Run sync automatically (default every 5 minutes)
  service status      Show when it runs next
  service uninstall   Stop running it automatically

Add --json to status, folders, activity and review for machine-readable output.`;

/** The desktop app watches this file to know when to refresh. */
function notifyChanged() {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'changed'), String(Date.now()));
}

const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

function checkMyFilesFolder(main: DatabaseSync, folder: string) {
    if (folder === path.parse(folder).root || folder === os.homedir()) {
        throw new UserError(`Refusing to mirror straight into ${folder}; pick a dedicated folder.`);
    }
    for (const p of listPairs(main)) {
        if (p.kind === 'computer' && overlaps(folder, p.local)) {
            throw new UserError(`That folder overlaps one that's already synced (${p.local}).`);
        }
    }
}

const UPLOAD_KINDS: UploadKind[] = ['new', 'edits', 'moves', 'deletes'];

/** Upload kinds switched on for automatic runs. */
function enabledKinds(main: DatabaseSync) {
    return new Set((getMeta(main, 'uploads') ?? '').split(',').filter((k): k is UploadKind => UPLOAD_KINDS.includes(k as UploadKind)));
}

function parseKinds(words: string[]) {
    const kinds = new Set<UploadKind>();
    for (const w of words) {
        if (w === 'all') UPLOAD_KINDS.forEach((k) => kinds.add(k));
        else if (!UPLOAD_KINDS.includes(w as UploadKind)) throw new UserError(`Unknown kind "${w}" (use: ${UPLOAD_KINDS.join(', ')}, all)`);
        else kinds.add(w as UploadKind);
    }
    return kinds;
}

/** Log in from the keyring; one client serves every pair. */
async function openSession(main: DatabaseSync) {
    let clientUid = getMeta(main, 'client_uid');
    if (!clientUid) setMeta(main, 'client_uid', (clientUid = randomUUID()));
    const { client, api, username } = await openClient(clientUid);
    const account = getMeta(main, 'account');
    if (account && account !== username) {
        throw new UserError(`This sync belongs to ${account}. To sync ${username}, choose a new My Files folder first (config folder).`);
    }
    setMeta(main, 'account', username);
    return { client, api };
}

/**
 * Bytes left on Drive (the tighter of the Drive allowance and total storage),
 * remembered for the app. Unknown (e.g. an older plan's fields) = unlimited;
 * Drive's own "full" answer is the backstop then.
 */
async function spaceLeft(api: Api, main: DatabaseSync) {
    try {
        const { User } = await api.request('GET', 'core/v4/users');
        const pairs: [number | undefined, number | undefined][] = [
            [User.MaxDriveSpace, User.UsedDriveSpace],
            [User.MaxSpace, User.UsedSpace],
        ];
        const left = pairs.filter(([max, used]) => typeof max === 'number' && typeof used === 'number' && max > 0).map(([max, used]) => max! - used!);
        const used = User.UsedDriveSpace ?? User.UsedSpace;
        const max = User.MaxDriveSpace ?? User.MaxSpace;
        if (typeof used === 'number' && typeof max === 'number') setMeta(main, 'storage', JSON.stringify({ used, max, atMs: Date.now() }));
        return left.length ? Math.max(0, Math.min(...left)) : Infinity;
    } catch {
        return Infinity;
    }
}

/** One message when Drive fills up (not one per file); cleared once everything fits. */
function reportSpace(main: DatabaseSync, budget: SpaceBudget) {
    const before = getMeta(main, 'space_waiting');
    if (!budget.waitingFiles) {
        if (before) main.prepare("DELETE FROM meta WHERE key = 'space_waiting'").run();
        return;
    }
    setMeta(main, 'space_waiting', JSON.stringify({ files: budget.waitingFiles, bytes: budget.waitingBytes }));
    if (!before) {
        const message = `Drive is full: ${budget.waitingFiles.toLocaleString()} file(s) (${humanSize(budget.waitingBytes)}) are waiting to upload`;
        addActivity(main, 'warning', '', `${message}. Free up space on Drive (and empty its trash) or add storage; uploads resume by themselves.`);
        console.log(`\n${message}.`);
    }
}

function mirrorFor(
    client: ProtonDriveClient,
    main: DatabaseSync,
    pair: Pair,
    hooks: { onActivity?: (kind: string, rel: string) => void; onScan?: (checked: number) => void } = {},
) {
    return new Mirror(client, pair.db, pair.local, { remoteRootUid: pair.remoteUid, trash: trashTarget(main), ...hooks });
}

/** Folder size before and after exclusions, for the "add folder" check. */
async function measureFolder(dir: string, patterns: string[]) {
    const excluded = makeExcluder(patterns);
    const result = { files: 0, bytes: 0, includedFiles: 0, includedBytes: 0 };
    const walk = async (rel: string, skipped: boolean) => {
        let entries;
        try {
            entries = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true });
        } catch {
            return;
        }
        for (const d of entries) {
            const childRel = rel ? `${rel}/${d.name}` : d.name;
            const isSkipped = skipped || excluded(childRel);
            if (d.isDirectory()) await walk(childRel, isSkipped);
            else if (d.isFile()) {
                const size = (await fs.promises.stat(path.join(dir, childRel)).catch(() => ({ size: 0 }))).size;
                result.files++;
                result.bytes += size;
                if (!isSkipped) {
                    result.includedFiles++;
                    result.includedBytes += size;
                }
            }
        }
    };
    await walk('', false);
    return result;
}

const humanSize = (n: number) =>
    n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;

function findPair(main: DatabaseSync, idOrDir: string) {
    const local = path.resolve(idOrDir);
    const pair = listPairs(main).find((p) => p.id === idOrDir || p.local === local);
    if (!pair) throw new UserError(`No synced folder ${idOrDir}`);
    return pair;
}

function pairById(main: DatabaseSync, id: string) {
    const pair = listPairs(main).find((p) => p.id === id);
    if (!pair) throw new UserError('That synced folder no longer exists.');
    return pair;
}

type UploadOptions = {
    // Kinds to carry out after catching up; default: those switched on.
    kinds?: Set<UploadKind>;
    // Sees every pair's plan first, and may cancel all of them.
    confirm?: (plans: { pair: Pair; plan: Plan }[]) => Promise<boolean>;
    allowMassDelete?: boolean;
};

/**
 * One sync run over every pair: catch up with Drive, then upload. A problem
 * in one pair is reported and the others still run; a login problem stops all.
 */
async function runAll(main: DatabaseSync, opts: { full?: boolean } & UploadOptions = {}) {
    const pairs = listPairs(main);
    if (!pairs.length) {
        throw new UserError('Nothing to sync yet: set a My Files folder (mirror <folder>) or add one (folders add <dir>).');
    }
    acquireLock(STATE_DIR);
    const runId = startRun(main);
    notifyChanged();

    // Stop button / logout / Ctrl+C: stop safely at the next step. A second
    // request stops at once (the next run cleans up).
    const onSignal = () => {
        if (stopRequested()) process.exit(130);
        console.log('\nStopping safely after the current step…');
        requestStop();
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);

    const totals = { downloaded: 0, uploaded: 0, created: 0, trashedOnDrive: 0, trashed: 0, skipped: 0, failures: 0 };
    const errors: string[] = [];
    const mirrors = new Map<Pair, Mirror>();

    // Live progress for the app, written at most about once a second.
    const progress = { startedMs: Date.now(), lastMs: 0, lastItem: '', folder: '', scanning: '', scanned: 0 };
    let lastWrite = 0;
    let pending: NodeJS.Timeout | undefined;
    const writeProgress = () => {
        lastWrite = Date.now();
        const live = { downloaded: 0, uploaded: 0, created: 0, trashedOnDrive: 0, trashed: 0, failures: 0 };
        for (const m of mirrors.values()) for (const k of Object.keys(live) as (keyof typeof live)[]) live[k] += m[k];
        setMeta(main, 'progress', JSON.stringify({ ...progress, ...live }));
        notifyChanged();
    };
    const soon = () => {
        const wait = 1000 - (Date.now() - lastWrite);
        if (wait <= 0) writeProgress();
        else pending ??= setTimeout(() => ((pending = undefined), writeProgress()), wait);
    };
    const onActivity = (folder: string) => (_kind: string, rel: string) => {
        Object.assign(progress, { lastMs: Date.now(), lastItem: rel, folder, scanning: '' });
        soon();
    };
    const onScan = (folder: string) => (checked: number) => {
        Object.assign(progress, { scanning: folder, scanned: checked });
        soon();
    };
    const endProgress = () => {
        clearTimeout(pending);
        main.prepare("DELETE FROM meta WHERE key = 'progress'").run();
    };
    const add = (m: Mirror) => {
        totals.downloaded += m.downloaded;
        totals.uploaded += m.uploaded;
        totals.created += m.created;
        totals.trashedOnDrive += m.trashedOnDrive;
        totals.trashed += m.trashed;
        totals.skipped += m.skipped;
        totals.failures += m.failures;
    };

    try {
        const { client, api } = await openSession(main);
        const kinds = opts.kinds ?? enabledKinds(main);
        const plans: { pair: Pair; plan: Plan }[] = [];

        for (const pair of pairs) {
            const mirror = mirrorFor(client, main, pair, { onActivity: onActivity(pair.label), onScan: onScan(pair.label) });
            mirrors.set(pair, mirror);
            try {
                await mirror.run({ full: opts.full });
                if (!kinds.size || mirror.failures) continue;
                const full = await planUploads(pair.db, pair.local, { allowMassDelete: opts.allowMassDelete });
                // Remember held mass deletions so the app can ask about them.
                const held = kinds.has('deletes') ? (full.massDelete?.files ?? 0) : 0;
                if (String(held) !== (getMeta(pair.db, 'mass_delete_held') ?? '0')) {
                    setMeta(pair.db, 'mass_delete_held', String(held));
                    if (held) {
                        console.log(
                            `${pair.label}: ${held} files were deleted here at once; they were NOT deleted on Drive. ` +
                                'Confirm with: push deletes --allow-many, or undo with: restore-deleted',
                        );
                    }
                }
                const plan = planForKinds(pair.db, full, kinds);
                if (plan.blocked) console.log(`${pair.label}: ${plan.blocked}`);
                plans.push({ pair, plan });
            } catch (error) {
                if (error instanceof StopRequested || error instanceof AuthError || (error instanceof ApiError && error.status === 401)) throw error;
                totals.failures++;
                errors.push(`${pair.label}: ${error instanceof Error ? error.message : String(error)}`);
                console.error(`✗ ${pair.label}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const work = plans.filter((p) => p.plan.items.length);
        if (opts.confirm && !work.length) {
            printPlans(plans, 'Will');
            console.log('\nNothing of that kind to upload right now.');
        } else if (work.length && (!opts.confirm || (await opts.confirm(plans)))) {
            // One space budget for every folder: only uploads that fit are tried.
            const needsSpace = work.some(({ plan }) => plan.items.some((i) => i.action === 'upload' || i.action === 'update'));
            const budget = new SpaceBudget(needsSpace ? await spaceLeft(api, main) : Infinity);
            for (const { pair, plan } of work) await mirrors.get(pair)!.applyPlan(plan, kinds, budget);
            if (kinds.has('new') || kinds.has('edits')) reportSpace(main, budget);
        } else if (kinds.has('new') || kinds.has('edits')) {
            reportSpace(main, new SpaceBudget(Infinity));
        }
    } catch (error) {
        endProgress();
        for (const m of mirrors.values()) add(m);
        if (error instanceof StopRequested) {
            finishRun(main, runId, { ...totals, errorKind: 'stopped', error: 'Stopped by you' });
            notifyChanged();
            console.log(`\nStopped. Done before stopping: ${totals.downloaded} downloaded, ${totals.uploaded} uploaded, ${totals.created} folders created. The next sync carries on from here.`);
            return;
        }
        const auth = error instanceof AuthError || (error instanceof ApiError && error.status === 401);
        finishRun(main, runId, {
            ...totals,
            failures: totals.failures + 1,
            errorKind: auth ? 'auth' : 'other',
            error: error instanceof Error ? error.message : String(error),
        });
        notifyChanged();
        throw error;
    }
    endProgress();
    for (const m of mirrors.values()) add(m);
    finishRun(main, runId, { ...totals, error: errors.length ? errors.join('; ') : undefined, errorKind: errors.length ? 'other' : undefined });
    notifyChanged();

    const parts = [`${totals.downloaded} downloaded`];
    if (totals.uploaded) parts.push(`${totals.uploaded} uploaded`);
    if (totals.created) parts.push(`${totals.created} folders created on Drive`);
    if (totals.trashedOnDrive) parts.push(`${totals.trashedOnDrive} moved to Drive's trash`);
    if (totals.trashed) parts.push(`${totals.trashed} moved to trash (deleted on Drive)`);
    if (totals.skipped) parts.push(`${totals.skipped} skipped (see: review)`);
    if (totals.failures) parts.push(`${totals.failures} failed; they will be retried next run`);
    const where = pairs.length === 1 ? pairs[0].local : `${pairs.length} folders`;
    console.log(`\nSynced ${where}: ${parts.join(', ')}.`);
    if (totals.failures) process.exitCode = 1;
}

function printPlan(plan: Plan, verb: 'Would' | 'Will', indent = '') {
    if (plan.blocked) return console.log(`${indent}${plan.blocked}`);
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
    if (!plan.items.length && !plan.held.length) return console.log(`${indent}Nothing to upload: Drive already matches this folder.`);
    for (const [title, lines] of groups) {
        if (!lines.length) continue;
        console.log(`${indent}${title}:`);
        for (const line of lines) console.log(`${indent}  ${line}`);
    }
}

/** Plans for one or more pairs; headed by folder when there are several. */
function printPlans(plans: { pair: Pair; plan: Plan }[], verb: 'Would' | 'Will') {
    console.log('');
    for (const { pair, plan } of plans) {
        if (plans.length > 1) console.log(`── ${pair.label}  (${pair.local})`);
        printPlan(plan, verb, plans.length > 1 ? '  ' : '');
    }
    if (verb === 'Would') console.log('\nThis was a dry run: nothing was changed on Drive.');
}

async function status(main: DatabaseSync) {
    const lastRun = main.prepare('SELECT * FROM runs WHERE finished_ms IS NOT NULL ORDER BY id DESC LIMIT 1').get() as any;
    const pairs = listPairs(main);
    const reviewCount = (db: DatabaseSync) => (db.prepare('SELECT COUNT(*) AS n FROM review WHERE dismissed = 0').get() as any).n as number;
    return {
        username: await savedUsername(),
        // My Files' local folder (kept for older app versions).
        folder: getMeta(main, 'root_dir') ?? null,
        firstSyncDone: pairs.length > 0 && pairs.every((p) => !!getMeta(p.db, 'event_id')),
        folders: pairs.map((p) => ({
            id: p.id,
            kind: p.kind,
            label: p.label,
            local: p.local,
            firstSyncDone: !!getMeta(p.db, 'event_id'),
            reviewCount: reviewCount(p.db),
            excludes: excludeSettings(p.db),
        })),
        computerName: os.hostname(),
        // The account the current sync setup belongs to (may differ from the
        // logged-in one only while logged out).
        syncAccount: getMeta(main, 'account') ?? null,
        running: lockHolder(STATE_DIR) !== null,
        progress: lockHolder(STATE_DIR) !== null ? JSON.parse(getMeta(main, 'progress') ?? 'null') : null,
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
        reviewCount: pairs.reduce((n, p) => n + reviewCount(p.db), 0),
        trash: trashTarget(main),
        uploads: [...enabledKinds(main)],
        massDeleteHeld: pairs.reduce((n, p) => n + Number(getMeta(p.db, 'mass_delete_held') ?? 0), 0),
        storage: JSON.parse(getMeta(main, 'storage') ?? 'null'),
        spaceWaiting: JSON.parse(getMeta(main, 'space_waiting') ?? 'null'),
        service: serviceInfo(),
    };
}

async function main(command: string | undefined, args: string[]) {
    const json = args.includes('--json');
    const positional = args.filter((a) => !a.startsWith('--'));

    switch (command) {
        case 'login': {
            const main = openState();
            const previous = getMeta(main, 'account');
            if (previous && !json) {
                console.log(
                    `Sync is set up for ${previous}. Logging in as a different account starts fresh: folder pairings are ` +
                        'forgotten and uploads switched off. Files stay where they are, here and on Drive.\n',
                );
            }
            if (json) await machineLogin();
            else await interactiveLogin();
            const now = await savedUsername();
            if (previous && now && previous.toLowerCase() !== now.toLowerCase()) {
                acquireLock(STATE_DIR);
                startFreshForNewAccount(main);
                if (json) process.stdout.write(JSON.stringify({ event: 'fresh-start', previous }) + '\n');
                else console.log(`Started fresh for ${now}: choose folders to sync (uploads are off until you switch them on).`);
            }
            notifyChanged();
            return;
        }
        case 'logout':
            await logout();
            notifyChanged();
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
        case 'mirror': {
            const main = openState();
            if (positional[0]) {
                const folder = path.resolve(positional[0]);
                const current = getMeta(main, 'root_dir');
                if (current && current !== folder) {
                    throw new UserError(`My Files already syncs with ${current}; to change it use: config folder <dir>`);
                }
                checkMyFilesFolder(main, folder);
                setMeta(main, 'root_dir', folder);
            }
            return runAll(main, { full: args.includes('--full') });
        }
        case 'folders': {
            const main = openState();
            const [action, target] = positional;
            if (action === 'measure') {
                if (!target) throw new UserError('Usage: folders measure <dir>');
                const m = await measureFolder(path.resolve(target), DEFAULT_EXCLUDES);
                if (json) return console.log(JSON.stringify(m));
                return console.log(
                    `${m.files.toLocaleString()} files (${humanSize(m.bytes)}); after skipping node_modules, .git, caches and similar: ` +
                        `${m.includedFiles.toLocaleString()} files (${humanSize(m.includedBytes)}).`,
                );
            }
            if (action === 'excludes') {
                if (!target) throw new UserError('Usage: folders excludes <dir|id> [--defaults on|off] [--set <pattern>...]');
                const pair = findPair(main, target);
                const settings = excludeSettings(pair.db);
                const defaultsArg = args[args.indexOf('--defaults') + 1];
                const setAt = args.indexOf('--set');
                if (args.includes('--defaults') || setAt >= 0) {
                    acquireLock(STATE_DIR);
                    saveExcludeSettings(pair.db, {
                        defaults: args.includes('--defaults') ? defaultsArg !== 'off' : settings.defaults,
                        custom: setAt >= 0 ? args.slice(setAt + 1).filter((a) => !a.startsWith('--')) : settings.custom,
                    });
                    notifyChanged();
                }
                const now = excludeSettings(pair.db);
                if (json) return console.log(JSON.stringify(now));
                console.log(`${pair.local} never syncs:`);
                console.log(`  defaults (${now.defaults ? 'on' : 'off'}): ${DEFAULT_EXCLUDES.join(', ')}`);
                console.log(`  yours: ${now.custom.length ? now.custom.join(', ') : 'none'}`);
                return;
            }
            if (action === 'add') {
                if (!target) throw new UserError('Usage: folders add <dir>');
                const problem = checkNewLocal(main, path.resolve(target));
                if (problem) throw new UserError(problem);
                if (!args.includes('--yes')) {
                    const m = await measureFolder(path.resolve(target), DEFAULT_EXCLUDES);
                    console.log(
                        `${path.resolve(target)} has ${m.files.toLocaleString()} files (${humanSize(m.bytes)}). ` +
                            `After skipping node_modules, .git, caches and similar: ${m.includedFiles.toLocaleString()} files (${humanSize(m.includedBytes)}).`,
                    );
                    const answer = await ask('Sync this folder? [y/N] ');
                    if (!/^y(es)?$/i.test(answer)) return console.log('Not added.');
                }
                const { client } = await openSession(main);
                const added = await addPair(main, client, target);
                notifyChanged();
                return console.log(
                    `Added. ${path.resolve(target)} now syncs with Computers → ${added.deviceName} → ${added.name} on Drive.\n` +
                        'Its files are uploaded on the next sync (if uploading new files is switched on: config uploads new).',
                );
            }
            if (action === 'remove') {
                if (!target) throw new UserError('Usage: folders remove <dir|id>');
                acquireLock(STATE_DIR);
                let local;
                try {
                    local = removePair(main, target);
                } catch (error) {
                    throw new UserError((error as Error).message);
                }
                notifyChanged();
                return console.log(`Stopped syncing ${local}. Its files stay where they are, here and on Drive.`);
            }
            if (action) throw new UserError('Usage: folders | folders add <dir> | folders remove <dir|id>');
            const pairs = listPairs(main).map((p) => ({ id: p.id, kind: p.kind, label: p.label, local: p.local }));
            if (json) return console.log(JSON.stringify(pairs));
            if (!pairs.length) return console.log('No synced folders yet.');
            for (const p of pairs) {
                console.log(`${p.local}\n  ↔ ${p.kind === 'myfiles' ? 'My Files' : `Computers → ${os.hostname()} → ${p.label}`}   (id: ${p.id})`);
            }
            return;
        }
        case 'stop': {
            const pid = lockHolder(STATE_DIR);
            if (!pid) return console.log('No sync is running.');
            process.kill(pid, 'SIGTERM');
            console.log('Asked the sync to stop; it finishes or cancels the current step first…');
            for (let waited = 0; waited < 120; waited++) {
                await new Promise((r) => setTimeout(r, 500));
                if (lockHolder(STATE_DIR) === null) return console.log('Stopped.');
            }
            throw new UserError('It is taking a while to stop (a large step?). It will stop on its own; you can check with: status');
        }
        case 'push': {
            const kinds = parseKinds(positional);
            if (!kinds.size) throw new UserError('Say what to upload, e.g.  push new');
            return runAll(openState(), {
                kinds,
                allowMassDelete: args.includes('--allow-many'),
                confirm: async (plans) => {
                    printPlans(plans, 'Will');
                    if (args.includes('--yes')) return true;
                    const n = plans.reduce((sum, p) => sum + p.plan.items.length, 0);
                    const answer = await ask(`\nMake ${n === 1 ? 'this change' : `these ${n} changes`} on Drive? [y/N] `);
                    if (/^y(es)?$/i.test(answer)) return true;
                    console.log('Cancelled; nothing was changed on Drive.');
                    return false;
                },
            });
        }
        case 'restore-deleted': {
            const main = openState();
            acquireLock(STATE_DIR);
            const { client } = await openSession(main);
            let restored = 0;
            let any = false;
            for (const pair of listPairs(main)) {
                const plan = await planUploads(pair.db, pair.local);
                if (!plan.massDelete) continue;
                any = true;
                const mirror = mirrorFor(client, main, pair);
                mirror.restoreMissing(plan.massDelete.items);
                setMeta(pair.db, 'mass_delete_held', '0');
                await mirror.run();
                restored += mirror.downloaded;
            }
            notifyChanged();
            return console.log(any ? `\nRestored: ${restored} files downloaded again.` : 'No held deletions to undo.');
        }
        case 'plan': {
            const main = openState();
            // Catch up with Drive first (uploading nothing), so conflicts are already in Review.
            await runAll(main, { kinds: new Set() });
            const plans = [];
            for (const pair of listPairs(main)) plans.push({ pair, plan: await planUploads(pair.db, pair.local) });
            if (json) return console.log(JSON.stringify(plans.map(({ pair, plan }) => ({ folder: pair.id, label: pair.label, ...plan }))));
            return printPlans(plans, 'Would');
        }
        case 'status': {
            const s = await status(openState());
            if (json) return console.log(JSON.stringify(s));
            console.log(`Logged in:   ${s.username ?? 'no'}`);
            for (const f of s.folders) {
                console.log(`Folder:      ${f.local}  ↔  ${f.kind === 'myfiles' ? 'My Files' : `Computers → ${s.computerName} → ${f.label}`}`);
            }
            if (!s.folders.length) console.log('Folders:     none yet');
            console.log(`Running now: ${s.running ? 'yes' : 'no'}`);
            if (s.lastRun) {
                const r = s.lastRun;
                console.log(
                    `Last run:    ${new Date(r.finishedMs).toLocaleString()}, ${r.error ? `problem: ${r.error}` : `${r.downloaded} downloaded, ${r.skipped} skipped, ${r.failures} failed`}`,
                );
            }
            if (s.reviewCount) console.log(`To review:   ${s.reviewCount} skipped file(s) (see: review)`);
            if (s.storage) console.log(`Drive storage: ${humanSize(s.storage.used)} of ${humanSize(s.storage.max)} used`);
            if (s.spaceWaiting) console.log(`Drive is full: ${s.spaceWaiting.files} file(s) (${humanSize(s.spaceWaiting.bytes)}) waiting to upload`);
            console.log(`Drive deletes go to: ${describeTrash(s.trash)}`);
            console.log(`Uploads:     ${s.uploads.length ? s.uploads.join(', ') : 'off (download only)'}`);
            console.log(`Automatic:   ${s.service.enabled ? (s.service.intervalMinutes ? `every ${s.service.intervalMinutes} min` : 'on') : 'off'}`);
            return;
        }
        case 'activity': {
            const limit = Number(args[args.indexOf('--limit') + 1]) || 100;
            const pairs = listPairs(openState());
            const rows = pairs
                .flatMap((p) =>
                    (p.db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit) as any[]).map((r) => ({
                        timeMs: r.time_ms as number,
                        kind: r.kind as string,
                        path: r.path as string,
                        detail: r.detail as string | null,
                        folder: p.label,
                    })),
                )
                .sort((a, b) => b.timeMs - a.timeMs)
                .slice(0, limit);
            if (json) return console.log(JSON.stringify(rows));
            for (const r of rows.reverse()) {
                const where = pairs.length > 1 ? `${r.folder} › ` : '';
                console.log(`${new Date(r.timeMs).toLocaleString()}  ${r.kind.padEnd(8)} ${where}${r.path}${r.detail ? `  (${r.detail})` : ''}`);
            }
            return;
        }
        case 'review': {
            const main = openState();
            const pairs = listPairs(main);
            const query = (db: DatabaseSync) => db.prepare('SELECT * FROM review WHERE dismissed = 0 ORDER BY time_ms').all() as any[];
            if (pairs.some((p) => query(p.db).some((r) => r.drive_mtime_ms === null))) {
                // Older items lack the Drive version's details: look them up once.
                try {
                    const { client } = await openSession(main);
                    for (const p of pairs) await mirrorFor(client, main, p).fillReviewDetails();
                } catch {
                    // Offline or logged out: show what we have.
                }
            }
            const items = pairs.flatMap((p) =>
                query(p.db).map((r) => {
                    let local: { mtimeMs: number; size: number } | null = null;
                    try {
                        const stat = fs.statSync(path.join(p.local, r.rel_path));
                        local = { mtimeMs: Math.trunc(stat.mtimeMs), size: stat.size };
                    } catch {
                        // The local file was moved or deleted since.
                    }
                    const drive = r.drive_mtime_ms === null ? null : { mtimeMs: r.drive_mtime_ms, size: r.drive_size };
                    // My Files items keep their plain id (older app versions use it).
                    const id = p.kind === 'myfiles' ? r.uid : `${p.id}:${r.uid}`;
                    return { id, path: r.rel_path, folder: p.label, localRoot: p.local, reason: r.reason, timeMs: r.time_ms, local, drive };
                }),
            );
            if (json) return console.log(JSON.stringify(items));
            if (!items.length) return console.log('Nothing to review.');
            const describe = (side: { mtimeMs: number; size: number | null } | null) =>
                side ? `modified ${new Date(side.mtimeMs).toLocaleString()}${side.size !== null ? `, ${side.size} bytes` : ''}` : 'unknown';
            for (const item of items) {
                console.log(`${pairs.length > 1 ? `${item.folder} › ` : ''}${item.path}`);
                console.log(`  ${item.reason === 'local-edit' ? 'Changed both here and on Drive' : 'Same name as a Drive file, but not created by sync'}`);
                console.log(`  This computer: ${item.local ? describe(item.local) : 'missing'}`);
                console.log(`  Drive:         ${describe(item.drive)}`);
                console.log(`  id: ${item.id}`);
            }
            return;
        }
        case 'resolve': {
            const [id, action] = positional;
            if (!id || (action !== 'keep-local' && action !== 'keep-both')) {
                throw new UserError('Usage: npm run pdsync -- resolve <id> keep-local|keep-both');
            }
            const main = openState();
            // "<folder id>:<item id>" for added folders; a plain item id is My Files
            // (Drive's ids never contain a colon).
            const colon = id.indexOf(':');
            const pair = pairById(main, colon > 0 ? id.slice(0, colon) : 'myfiles');
            const uid = colon > 0 ? id.slice(colon + 1) : id;
            acquireLock(STATE_DIR);
            try {
                const { client } = await openSession(main);
                await mirrorFor(client, main, pair).resolve(uid, action, { uploadsEdits: enabledKinds(main).has('edits') });
            } finally {
                notifyChanged();
            }
            return;
        }
        case 'config': {
            const [key, value] = positional;
            const main = openState();
            if (key === 'uploads' && value) {
                const kinds = value === 'none' ? new Set<UploadKind>() : parseKinds(positional.slice(1));
                setMeta(main, 'uploads', [...kinds].join(','));
                notifyChanged();
                return console.log(kinds.size ? `Automatic runs now upload: ${[...kinds].join(', ')}.` : 'Automatic runs upload nothing (download only).');
            }
            if (key === 'trash' && value) {
                if (value === 'desktop') {
                    main.prepare("DELETE FROM meta WHERE key = 'trash'").run();
                } else {
                    const resolved = path.resolve(value);
                    for (const p of listPairs(main)) {
                        if (overlaps(resolved, p.local)) throw new UserError(`The trash folder must be outside synced folders (${p.local}).`);
                    }
                    let dir;
                    try {
                        dir = await prepareTrashFolder(value, undefined);
                    } catch (error) {
                        throw new UserError((error as Error).message);
                    }
                    setMeta(main, 'trash', dir);
                }
                notifyChanged();
                return console.log(`Files deleted on Drive now go to ${describeTrash(trashTarget(main))}.`);
            }
            if (key !== 'folder' || !value) throw new UserError('Usage: config folder <dir> | config uploads <kinds>|none | config trash desktop|<dir>');
            const folder = path.resolve(value);
            checkMyFilesFolder(main, folder);
            if (folder === getMeta(main, 'root_dir')) return console.log(`Already mirroring into ${folder}.`);
            acquireLock(STATE_DIR);
            // Start the new mirror from scratch; nothing on disk is touched.
            main.exec("DELETE FROM nodes; DELETE FROM review; DELETE FROM leftovers; DELETE FROM meta WHERE key IN ('event_id', 'scope', 'layout', 'mass_delete_held');");
            setMeta(main, 'root_dir', folder);
            notifyChanged();
            console.log(`From the next run, My Files is mirrored into ${folder}.`);
            return;
        }
        case 'service': {
            const [action, minutes] = positional;
            if (action === 'status') return serviceStatus();
            const main = openState();
            if (action === 'install') {
                if (!listPairs(main).length) throw new UserError('Set up a folder to sync first (mirror <folder> or folders add <dir>).');
                installService(main, minutes ? Number(minutes) : undefined);
            } else if (action === 'uninstall') uninstallService();
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
