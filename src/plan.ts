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

/** The kinds of change the user can switch on separately. */
export type UploadKind = 'new' | 'edits' | 'moves' | 'deletes';

export function kindOf(item: PlanItem): UploadKind {
    return item.action === 'create-folder' || item.action === 'upload'
        ? 'new'
        : item.action === 'update'
          ? 'edits'
          : item.action === 'move'
            ? 'moves'
            : 'deletes';
}

export type Plan = {
    items: PlanItem[];
    held: { rel: string; why: string }[];
    /** Set when the whole plan is refused (e.g. the folder looks unmounted). */
    blocked?: string;
    /** Deletions held because so many happened at once; need confirming. */
    massDelete?: { files: number; items: Extract<PlanItem, { action: 'trash' }>[] };
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

export async function planUploads(db: DatabaseSync, root: string, { allowMassDelete = false } = {}): Promise<Plan> {
    const allRows = db.prepare('SELECT * FROM nodes').all() as NodeRow[];
    // Shortcuts to online documents are sync's own: never uploaded, and
    // deleting one never touches the document on Drive.
    const links = allRows.filter((r) => r.type === 'link');
    const rows = allRows.filter((r) => r.type !== 'link') as (NodeRow & { type: 'file' | 'folder' })[];
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
    const claimed = new Set<string>(links.map((l) => l.rel_path)); // local paths accounted for

    /** A row whose local entry is at `rel`: unchanged, edited, or held. */
    const settle = (row: NodeRow & { type: 'file' | 'folder' }, rel: string, e: LocalEntry) => {
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

    // Copies sync left behind and no longer tracks (see the leftovers table).
    const leftovers = new Map(
        (db.prepare('SELECT * FROM leftovers').all() as { rel_path: string; type: string; size: number | null; mtime_ms: number | null; reason: string }[]).map(
            (l) => [l.rel_path, l],
        ),
    );
    const leftoverWhy: Record<string, string> = {
        'removed-on-drive': 'removed on Drive; kept here, not uploaded again',
        'rename-clash': 'an old copy sync left behind after a rename on Drive; not uploaded',
        'moved-on-drive': 'left behind when its folder moved on Drive; not uploaded',
    };
    const isLeftover = (e: LocalEntry) => {
        const left = leftovers.get(e.rel);
        return !!left && left.type === e.type && (e.type === 'folder' || (left.size === e.size && left.mtime_ms === e.mtimeMs));
    };

    // 2. Missing from its place: moved/renamed (same disk identity), or deleted.
    const byIno = new Map<number, LocalEntry>();
    for (const e of local.values()) if (!claimed.has(e.rel)) byIno.set(e.ino, e);
    const missing = rows.filter((r) => !done.has(r.uid)).sort((a, b) => depth(a.rel_path) - depth(b.rel_path));
    const trashed: typeof rows = [];

    for (const row of missing) {
        if (done.has(row.uid)) continue; // carried along with a moved folder
        // Same disk identity = renamed. Filesystems can reuse a deleted file's
        // inode, so a file must also still have the same size and mtime (a
        // rename keeps both); a renamed-and-edited file becomes trash + upload,
        // which is safe, just less efficient.
        let found = row.local_ino != null ? byIno.get(row.local_ino) : undefined;
        if (found && (found.type !== row.type || claimed.has(found.rel) || isLeftover(found))) found = undefined;
        if (found && row.type === 'file' && !matches(row, found)) found = undefined;
        if (!found && row.type === 'file' && row.local_ino == null) {
            // Rows recorded before inodes: accept a unique same-size, same-mtime newcomer.
            const candidates = [...local.values()].filter(
                (e) => e.type === 'file' && !claimed.has(e.rel) && !isLeftover(e) && matches(row, e),
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
            // Shortcuts inside travel too, and stay sync's own at the new path.
            for (const link of links) {
                if (isUnder(link.rel_path, row.rel_path)) claimed.add(found.rel + link.rel_path.slice(row.rel_path.length));
            }
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
    const trashItems: Extract<PlanItem, { action: 'trash' }>[] = [];
    for (const row of trashed) {
        if (trashedFolders.some((f) => f.uid !== row.uid && isUnder(row.rel_path, f.rel_path))) continue;
        const files = row.type === 'file' ? 1 : fileRows.filter((f) => isUnder(f.rel_path, row.rel_path)).length;
        deletedFiles += files;
        trashItems.push({ action: 'trash', uid: row.uid, type: row.type, rel: row.rel_path, files });
    }
    if (!allowMassDelete && deletedFiles >= MASS_DELETE_MIN_FILES && deletedFiles > fileRows.length * MASS_DELETE_SHARE) {
        plan.held.push({
            rel: '',
            why: `${deletedFiles} files are gone from the folder at once; their deletion needs your confirmation first`,
        });
        plan.massDelete = { files: deletedFiles, items: trashItems };
    } else {
        plan.items.push(...trashItems);
    }

    // 4. Everything else is new, except copies sync itself left behind.
    const heldFolders: string[] = [];
    const fresh = [...local.values()]
        .filter((e) => !claimed.has(e.rel))
        .sort((a, b) => depth(a.rel) - depth(b.rel) || a.rel.localeCompare(b.rel));
    const linkInos = new Set(links.map((l) => l.local_ino).filter((ino): ino is number => ino != null));
    for (const e of fresh) {
        // One of sync's own shortcuts, wherever it has ended up: never uploaded.
        if (e.type === 'file' && linkInos.has(e.ino)) continue;
        // Still exactly as sync left it (a file the user edits since becomes theirs).
        if (isLeftover(e)) {
            plan.held.push({ rel: e.rel, why: leftoverWhy[leftovers.get(e.rel)!.reason] ?? 'left behind by sync; not uploaded' });
            if (e.type === 'folder') heldFolders.push(e.rel);
        } else if (heldFolders.some((f) => isUnder(e.rel, f))) {
            plan.held.push({ rel: e.rel, why: 'inside a folder that was removed or moved on Drive' });
        } else if (reviewPaths.has(e.rel)) {
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

/**
 * The part of a plan to carry out when only some kinds are switched on. An
 * item is held back when the folder it goes into won't exist on Drive, e.g.
 * because that folder was moved here and moves aren't switched on yet.
 */
export function planForKinds(db: DatabaseSync, plan: Plan, kinds: Set<UploadKind>): Plan {
    if (plan.blocked) return plan;
    const folders = new Set(
        (db.prepare("SELECT rel_path FROM nodes WHERE type = 'folder'").all() as { rel_path: string }[]).map((r) => r.rel_path),
    );
    const enabled = plan.items.filter((i) => kinds.has(kindOf(i)));
    const pendingMoves = plan.items.filter(
        (i): i is Extract<PlanItem, { action: 'move' }> => i.action === 'move' && i.type === 'folder' && !kinds.has('moves'),
    );
    // Folders moved in this plan are on Drive at their new path afterwards.
    for (const move of enabled) {
        if (move.action !== 'move' || move.type !== 'folder') continue;
        for (const f of [...folders]) {
            if (isUnder(f, move.from)) {
                folders.delete(f);
                folders.add(move.to + f.slice(move.from.length));
            }
        }
    }

    const result: Plan = { items: [], held: [...plan.held] };
    for (const item of enabled) {
        const rel = item.action === 'move' ? item.to : item.rel;
        const parent = path.posix.dirname(rel);
        if (item.action !== 'trash' && item.action !== 'update' && parent !== '.' && !folders.has(parent)) {
            const waitingFor = pendingMoves.find((m) => isUnder(parent, m.to));
            result.held.push({
                rel,
                why: waitingFor
                    ? `waits for "${waitingFor.from}" to be moved to "${waitingFor.to}" on Drive (moves aren't switched on yet)`
                    : `its folder "${parent}" isn't on Drive yet`,
            });
            continue;
        }
        if (item.action === 'create-folder') folders.add(item.rel);
        result.items.push(item);
    }
    return result;
}
