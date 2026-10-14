// Upload planner: compares the local folder with what sync last recorded and
// works out what would need to change on Drive. It only reports; nothing here
// touches Drive. Run it after catching up with Drive, so conflicts are
// already in the review list (and held back here).
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { NodeRow } from './mirror.ts';

export type PlanItem =
    | { action: 'create-folder'; rel: string }
    | { action: 'upload'; rel: string; size: number }
    | { action: 'update'; uid: string; rel: string; size: number }
    | { action: 'move'; uid: string; type: 'file' | 'folder'; from: string; to: string }
    | { action: 'trash'; uid: string; type: 'file' | 'folder'; rel: string; files: number };

export type Plan = {
    items: PlanItem[];
    held: { rel: string; why: string }[];
    /** Set when the whole plan is refused (e.g. the folder looks unmounted). */
    blocked?: string;
};

type LocalEntry = { rel: string; type: 'file' | 'folder'; size: number; mtimeMs: number; ino: number };

// Names that are never uploaded: our own part files, editor/desktop scratch files.
const IGNORED: RegExp[] = [
    /\.pdsync-part$/,
    /^\.~lock\..*#$/, // LibreOffice lock files
    /~$/, // editor backups
    /^\..*\.sw[a-p]$/, // vim swap files
    /^\.goutputstream-/, // GTK atomic-save temp files
    /^\.directory$/, // Dolphin's per-folder view settings
    /^\.Trash-\d+$/, // desktop trash on removable drives
];

/** Deleting more than this many files, and this share of all files, at once needs confirmation. */
const MASS_DELETE_MIN_FILES = 10;
const MASS_DELETE_SHARE = 0.2;

export function isIgnored(name: string) {
    return IGNORED.some((re) => re.test(name));
}

async function scanLocal(root: string) {
    const entries = new Map<string, LocalEntry>();
    const walk = async (dirRel: string) => {
        for (const dirent of await fs.readdir(path.join(root, dirRel), { withFileTypes: true })) {
            if (isIgnored(dirent.name)) continue;
            // Symlinks and special files are not synced (and never followed).
            if (!dirent.isFile() && !dirent.isDirectory()) continue;
            const rel = dirRel ? `${dirRel}/${dirent.name}` : dirent.name;
            const stat = await fs.lstat(path.join(root, rel));
            const type = dirent.isDirectory() ? 'folder' : 'file';
            entries.set(rel, { rel, type, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), ino: stat.ino });
            if (type === 'folder') await walk(rel);
        }
    };
    await walk('');
    return entries;
}

const isUnder = (rel: string, folder: string) => rel === folder || rel.startsWith(folder + '/');
const depth = (rel: string) => rel.split('/').length;

export async function planUploads(db: DatabaseSync, root: string): Promise<Plan> {
    const rows = db.prepare('SELECT * FROM nodes').all() as NodeRow[];
    const plan: Plan = { items: [], held: [] };

    const rootStat = await fs.stat(root).catch(() => null);
    if (!rootStat?.isDirectory()) {
        return { ...plan, blocked: `The folder ${root} is missing (unmounted drive?), so nothing will be changed on Drive.` };
    }
    const local = await scanLocal(root);
    if (local.size === 0 && rows.length > 0) {
        return { ...plan, blocked: `The folder ${root} is empty, so nothing will be changed on Drive (it may not be mounted).` };
    }

    const review = db.prepare('SELECT uid, rel_path FROM review').all() as { uid: string; rel_path: string }[];
    const reviewUids = new Set(review.map((r) => r.uid));
    const reviewPaths = new Set(review.map((r) => r.rel_path));
    const backfillIno = db.prepare('UPDATE nodes SET local_ino = ? WHERE uid = ?');

    const matches = (row: NodeRow, e: LocalEntry) => e.size === row.local_size && e.mtimeMs === row.local_mtime_ms;
    const done = new Set<string>(); // row uids accounted for
    const claimed = new Set<string>(); // local paths accounted for

    /** A row whose local entry is at `rel`: unchanged, edited, or held. */
    const settle = (row: NodeRow, rel: string, e: LocalEntry) => {
        done.add(row.uid);
        claimed.add(rel);
        if (row.local_ino == null && (row.type === 'folder' || matches(row, e))) backfillIno.run(e.ino, row.uid);
        if (row.type !== 'file' || matches(row, e)) return;
        if (reviewUids.has(row.uid)) plan.held.push({ rel, why: 'waiting in Review' });
        else plan.items.push({ action: 'update', uid: row.uid, rel, size: e.size });
    };

    // 1. Still where sync left it.
    for (const row of rows) {
        const e = local.get(row.rel_path);
        if (e && e.type === row.type) settle(row, row.rel_path, e);
    }

    // 2. Missing from its place: moved/renamed (same disk identity), or deleted.
    const byIno = new Map<number, LocalEntry>();
    for (const e of local.values()) if (!claimed.has(e.rel)) byIno.set(e.ino, e);
    const missing = rows.filter((r) => !done.has(r.uid)).sort((a, b) => depth(a.rel_path) - depth(b.rel_path));
    const trashed: NodeRow[] = [];

    for (const row of missing) {
        if (done.has(row.uid)) continue; // carried along with a moved folder
        let found = row.local_ino != null ? byIno.get(row.local_ino) : undefined;
        if (found && (found.type !== row.type || claimed.has(found.rel))) found = undefined;
        if (!found && row.type === 'file') {
            // Older rows have no inode: accept a unique same-size, same-mtime newcomer.
            const candidates = [...local.values()].filter(
                (e) => e.type === 'file' && !claimed.has(e.rel) && matches(row, e),
            );
            if (candidates.length === 1) found = candidates[0];
        }
        if (!found) {
            trashed.push(row);
            done.add(row.uid);
            continue;
        }

        plan.items.push({ action: 'move', uid: row.uid, type: row.type, from: row.rel_path, to: found.rel });
        settle(row, found.rel, found);
        if (row.type === 'folder') {
            // Contents travel with the folder: check them at their new paths.
            for (const child of rows) {
                if (done.has(child.uid) || child.uid === row.uid || !isUnder(child.rel_path, row.rel_path)) continue;
                const moved = found.rel + child.rel_path.slice(row.rel_path.length);
                const e = local.get(moved);
                if (e && e.type === child.type) settle(child, moved, e);
            }
        }
    }

    // 3. Deletions: a trashed folder takes its contents with it.
    const trashedFolders = trashed.filter((r) => r.type === 'folder');
    const fileRows = rows.filter((r) => r.type === 'file');
    let deletedFiles = 0;
    const trashItems: PlanItem[] = [];
    for (const row of trashed) {
        if (trashedFolders.some((f) => f.uid !== row.uid && isUnder(row.rel_path, f.rel_path))) continue;
        const files = row.type === 'file' ? 1 : fileRows.filter((f) => isUnder(f.rel_path, row.rel_path)).length;
        deletedFiles += files;
        trashItems.push({ action: 'trash', uid: row.uid, type: row.type, rel: row.rel_path, files });
    }
    if (deletedFiles >= MASS_DELETE_MIN_FILES && deletedFiles > fileRows.length * MASS_DELETE_SHARE) {
        plan.held.push({
            rel: '',
            why: `${deletedFiles} files are gone from the folder at once; their deletion needs your confirmation first`,
        });
    } else {
        plan.items.push(...trashItems);
    }

    // 4. Everything else is new.
    const fresh = [...local.values()]
        .filter((e) => !claimed.has(e.rel))
        .sort((a, b) => depth(a.rel) - depth(b.rel) || a.rel.localeCompare(b.rel));
    for (const e of fresh) {
        if (reviewPaths.has(e.rel)) {
            plan.held.push({ rel: e.rel, why: 'waiting in Review' });
        } else if (e.type === 'folder') {
            plan.items.push({ action: 'create-folder', rel: e.rel });
        } else {
            plan.items.push({ action: 'upload', rel: e.rel, size: e.size });
        }
    }

    // Folders first (so uploads have a parent), then moves, files, deletions.
    const order = { 'create-folder': 0, move: 1, upload: 2, update: 3, trash: 4 } as const;
    plan.items.sort((a, b) => order[a.action] - order[b.action]);
    return plan;
}
