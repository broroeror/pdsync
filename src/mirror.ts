// Download-only mirror of My Files into a local folder.
//
// Safety rules (this stage never changes anything on Drive):
//  - Never deletes local files. Items removed on Drive are reported and kept.
//  - Never overwrites a local file it didn't write, or one edited since.
//  - Writes atomically: download to a hidden part file, then rename.
//  - On any failure the event cursor is not advanced, so the next run retries.
import { once } from 'node:events';
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { DriveEventType, NodeType, type NodeEntity, type ProtonDriveClient } from '@protontech/drive-sdk';
import { verbose } from './logging.ts';

export const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'pdsync');
const PART_SUFFIX = '.pdsync-part';
// Online documents have no file content: they become shortcuts that open them
// in the browser. [what to call it, icon name]
const ONLINE_DOCS: Record<string, [string, string]> = {
    'application/vnd.proton.doc': ['online document', 'x-office-document'],
    'application/vnd.proton.sheet': ['online spreadsheet', 'x-office-spreadsheet'],
};
// Bumped when the local layout changes, to trigger one full rescan.
// 2: online documents become .desktop shortcuts.
const LAYOUT_VERSION = '2';
// Guards against a broken parent chain looping forever.
const MAX_PARENT_DEPTH = 64;

type Row = {
    uid: string;
    // 'link' = a shortcut sync writes for an online document (Proton Docs and
    // Sheets have no file content); the planner never uploads or deletes these.
    type: 'file' | 'folder' | 'link';
    rel_path: string;
    // Files only: the revision we last wrote, and the size/mtime it had on disk
    // right after, so a later mismatch means it was edited locally.
    revision_uid: string | null;
    local_size: number | null;
    local_mtime_ms: number | null;
    // Disk identity (inode) of what we wrote: survives renames, so a local
    // rename can be told apart from delete + new file.
    local_ino?: number | null;
};

export type { Row as NodeRow };

export function openState() {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(STATE_DIR, 'mirror.db'));
    db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS nodes (
            uid TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            rel_path TEXT NOT NULL,
            revision_uid TEXT,
            local_size INTEGER,
            local_mtime_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY,
            started_ms INTEGER NOT NULL,
            finished_ms INTEGER,
            downloaded INTEGER,
            skipped INTEGER,
            failures INTEGER,
            -- 'auth' = the saved login stopped working; 'other' = anything else.
            error_kind TEXT,
            error TEXT
        );
        CREATE TABLE IF NOT EXISTS activity (
            id INTEGER PRIMARY KEY,
            time_ms INTEGER NOT NULL,
            kind TEXT NOT NULL,      -- download | move | removed | skipped | failed | warning | resolved
            path TEXT NOT NULL,
            detail TEXT
        );
        -- Files the mirror deliberately didn't touch, awaiting a decision.
        CREATE TABLE IF NOT EXISTS review (
            uid TEXT PRIMARY KEY,
            rel_path TEXT NOT NULL,
            reason TEXT NOT NULL,    -- local-edit | local-exists
            revision_uid TEXT NOT NULL,
            time_ms INTEGER NOT NULL,
            -- 1 = "keep mine" for this Drive revision: stay quiet until Drive changes again.
            dismissed INTEGER NOT NULL DEFAULT 0
        );
    `);
    // Local copies sync left behind and no longer tracks, so the upload planner
    // doesn't mistake them for new files of the user's.
    db.exec(`
        CREATE TABLE IF NOT EXISTS leftovers (
            rel_path TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            size INTEGER,
            mtime_ms INTEGER,
            reason TEXT NOT NULL,    -- removed-on-drive | rename-clash | moved-on-drive
            time_ms INTEGER NOT NULL
        );
    `);
    // Added later: the Drive version's details, shown next to the local file.
    const reviewColumns = new Set((db.prepare('PRAGMA table_info(review)').all() as { name: string }[]).map((c) => c.name));
    if (!reviewColumns.has('drive_mtime_ms')) db.exec('ALTER TABLE review ADD COLUMN drive_mtime_ms INTEGER');
    if (!reviewColumns.has('drive_size')) db.exec('ALTER TABLE review ADD COLUMN drive_size INTEGER');
    const nodeColumns = new Set((db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]).map((c) => c.name));
    if (!nodeColumns.has('local_ino')) db.exec('ALTER TABLE nodes ADD COLUMN local_ino INTEGER');
    return db;
}

const ACTIVITY_KEEP = 1000;

export function addActivity(db: DatabaseSync, kind: string, rel: string, detail?: string) {
    db.prepare('INSERT INTO activity (time_ms, kind, path, detail) VALUES (?, ?, ?, ?)').run(Date.now(), kind, rel, detail ?? null);
    db.prepare('DELETE FROM activity WHERE id <= (SELECT MAX(id) FROM activity) - ?').run(ACTIVITY_KEEP);
}

export function startRun(db: DatabaseSync) {
    return Number(db.prepare('INSERT INTO runs (started_ms) VALUES (?)').run(Date.now()).lastInsertRowid);
}

export function finishRun(
    db: DatabaseSync,
    id: number,
    r: { downloaded: number; skipped: number; failures: number; errorKind?: string; error?: string },
) {
    db.prepare(
        'UPDATE runs SET finished_ms = ?, downloaded = ?, skipped = ?, failures = ?, error_kind = ?, error = ? WHERE id = ?',
    ).run(Date.now(), r.downloaded, r.skipped, r.failures, r.errorKind ?? null, r.error ?? null, id);
    db.prepare('DELETE FROM runs WHERE id <= ? - 200').run(id);
}

export function getMeta(db: DatabaseSync, key: string) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
}

export function setMeta(db: DatabaseSync, key: string, value: string) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        value,
    );
}

async function statOrNull(p: string) {
    return fs.stat(p).catch(() => null);
}

function isUnder(rel: string, folderRel: string) {
    return rel === folderRel || rel.startsWith(folderRel + '/');
}

export class Mirror {
    private rootUid = '';
    private needsRescan = false;
    downloaded = 0;
    skipped = 0;
    failures = 0;

    constructor(
        private client: ProtonDriveClient,
        private db: DatabaseSync,
        private root: string,
    ) {}

    async run({ full = false } = {}) {
        const owner = getMeta(this.db, 'root_dir');
        if (owner && owner !== this.root) {
            throw new Error(`The sync state belongs to a mirror at ${owner}, not ${this.root}`);
        }
        setMeta(this.db, 'root_dir', this.root);
        await fs.mkdir(this.root, { recursive: true });

        const rootNode = await this.client.getMyFilesRootFolder();
        this.rootUid = rootNode.uid;
        const scope = rootNode.treeEventScopeId;
        const cursor = getMeta(this.db, 'event_id');

        if (getMeta(this.db, 'layout') !== LAYOUT_VERSION) full = true;
        if (!cursor || full || getMeta(this.db, 'scope') !== scope) {
            // Take the cursor *before* walking, so changes made during the walk
            // are replayed next run rather than missed.
            const latest = await this.latestEventId(scope);
            await this.fullWalk(rootNode);
            if (this.failures === 0) {
                setMeta(this.db, 'scope', scope);
                setMeta(this.db, 'event_id', latest);
                setMeta(this.db, 'layout', LAYOUT_VERSION);
            }
            await this.recheckReview();
            return;
        }

        for await (const event of this.client.iterateEvents(scope, cursor)) {
            switch (event.type) {
                case DriveEventType.NodeCreated:
                case DriveEventType.NodeUpdated:
                    if (event.isTrashed) this.removedRemotely(event.nodeUid);
                    else await this.syncByUid(event.nodeUid);
                    break;
                case DriveEventType.NodeDeleted:
                    this.removedRemotely(event.nodeUid);
                    break;
                case DriveEventType.TreeRefresh:
                    // The server says our cursor is too old to replay: rescan.
                    await this.fullWalk(rootNode);
                    break;
                case DriveEventType.TreeRemove:
                    throw new Error('Drive reports that the whole My Files tree was removed; not touching local files');
            }
            if (this.failures) break;
            if (event.eventId !== 'none') setMeta(this.db, 'event_id', event.eventId);
        }

        if (this.needsRescan && !this.failures) await this.fullWalk(rootNode);
        await this.recheckReview();
    }

    private async latestEventId(scope: string) {
        for await (const event of this.client.iterateEvents(scope)) {
            if (event.type === DriveEventType.FastForward) return event.eventId;
        }
        throw new Error('Drive did not return a starting event ID');
    }

    private async fullWalk(rootNode: NodeEntity) {
        const seen = new Set([rootNode.uid]);
        const queue: [string, string][] = [[rootNode.uid, '']];
        while (queue.length) {
            const [folderUid, folderRel] = queue.shift()!;
            try {
                for await (const child of this.client.iterateFolderChildren(folderUid)) {
                    if (child.trashTime) continue;
                    seen.add(child.uid);
                    await this.syncNode(child, folderRel);
                    const row = this.getRow(child.uid);
                    if (child.type === NodeType.Folder && row) queue.push([child.uid, row.rel_path]);
                }
            } catch (error) {
                this.fail(folderRel || 'My Files', 'listing', error);
            }
        }
        this.needsRescan = false;

        // Anything we knew about that the walk didn't see is gone from Drive.
        // Skip this if the walk was incomplete, or we'd misreport removals.
        if (this.failures) return;
        const rows = this.db.prepare('SELECT uid FROM nodes').all() as { uid: string }[];
        for (const { uid } of rows) if (!seen.has(uid)) this.removedRemotely(uid);
    }

    private async syncByUid(uid: string) {
        try {
            const node = await this.client.getNode(uid);
            if (node.trashTime) return this.removedRemotely(uid);
            const parentRel = await this.parentRelOf(node, 0);
            // null = not inside My Files (e.g. another tree on the volume).
            if (parentRel !== null) await this.syncNode(node, parentRel);
        } catch (error) {
            this.fail(this.getRow(uid)?.rel_path ?? uid, 'updating', error);
        }
    }

    /** Local path of a node's parent folder, syncing unknown ancestors first. */
    private async parentRelOf(node: NodeEntity, depth: number): Promise<string | null> {
        if (!node.parentUid || depth > MAX_PARENT_DEPTH) return null;
        if (node.parentUid === this.rootUid) return '';
        const known = this.getRow(node.parentUid);
        if (known?.type === 'folder') return known.rel_path;

        const parent = await this.client.getNode(node.parentUid);
        if (parent.trashTime) return null;
        const grandparentRel = await this.parentRelOf(parent, depth + 1);
        if (grandparentRel === null) return null;
        await this.syncNode(parent, grandparentRel);
        return this.getRow(parent.uid)?.rel_path ?? null;
    }

    private async syncNode(node: NodeEntity, parentRel: string) {
        const name = this.safeName(node);
        if (name === null) return;
        const rel = parentRel ? `${parentRel}/${name}` : name;
        const row = this.getRow(node.uid);

        if (node.type === NodeType.Folder) {
            if (row && row.rel_path !== rel) await this.moveFolder(row.rel_path, rel);
            await fs.mkdir(this.abs(rel), { recursive: true });
            const { ino } = await fs.stat(this.abs(rel));
            this.upsert({
                uid: node.uid,
                type: 'folder',
                rel_path: rel,
                revision_uid: null,
                local_size: null,
                local_mtime_ms: null,
                local_ino: ino,
            });
            return;
        }
        if (node.type !== NodeType.File) return;
        if (node.mediaType && ONLINE_DOCS[node.mediaType]) return this.syncOnlineDoc(node, rel, row);

        const revision = node.activeRevision;
        if (!revision) return this.warn(`${rel}: no finished revision on Drive yet, skipped`);

        let current = row;
        if (current && current.rel_path !== rel) current = await this.moveFile(current, rel);
        // Same revision as last time: nothing to fetch. If the local copy is
        // missing, the user removed it; a download-only mirror respects that.
        if (current && current.revision_uid === revision.uid) return;

        const existing = await statOrNull(this.abs(rel));
        if (existing && !(current && this.matches(current, existing))) {
            return this.needsReview(node.uid, rel, current ? 'local-edit' : 'local-exists', revision.uid, {
                mtimeMs: (revision.claimedModificationTime ?? node.modificationTime).getTime(),
                size: revision.claimedSize ?? null,
            });
        }
        await this.download(node, rel, revision.uid, revision.claimedModificationTime ?? node.modificationTime);
    }

    /** An online document becomes "<name>.desktop", a shortcut that opens it in the browser. */
    private async syncOnlineDoc(node: NodeEntity, rel: string, row: Row | undefined) {
        const linkRel = `${rel}.desktop`;
        if (row && row.type === 'file') {
            // Older versions wrote an empty placeholder: remove it only if it is
            // still exactly the empty file sync made (nothing to lose).
            const old = await statOrNull(this.abs(row.rel_path));
            if (old && old.size === 0 && this.matches(row, old)) await fs.rm(this.abs(row.rel_path));
            this.db.prepare('DELETE FROM nodes WHERE uid = ?').run(row.uid);
            row = undefined;
        }
        if (row && row.rel_path !== linkRel) {
            // Renamed on Drive: move our shortcut along (it is rewritten below).
            const old = await statOrNull(this.abs(row.rel_path));
            if (old && !(await statOrNull(this.abs(linkRel)))) {
                await fs.mkdir(path.dirname(this.abs(linkRel)), { recursive: true });
                await fs.rename(this.abs(row.rel_path), this.abs(linkRel));
                this.record('move', linkRel, row.rel_path);
                row = { ...row, rel_path: linkRel };
            }
        }

        const [kind, icon] = ONLINE_DOCS[node.mediaType!];
        const name = path.basename(rel);
        const content =
            `[Desktop Entry]\nType=Link\nName=${name}\nComment=${kind[0].toUpperCase() + kind.slice(1)}: opens in your browser\n` +
            `Icon=${icon}\nURL=${await this.client.experimental.getNodeUrl(node.uid)}\n`;
        const target = this.abs(linkRel);
        const existing = await fs.readFile(target, 'utf8').catch(() => null);
        if (existing === content) {
            if (!row || row.rel_path !== linkRel) await this.recordLink(node.uid, linkRel);
            return;
        }
        if (existing !== null && !(row && row.rel_path === linkRel)) {
            return this.warn(`${linkRel}: a file with this name already exists; shortcut to the ${kind} not created`);
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
        await this.recordLink(node.uid, linkRel);
        if (existing === null) this.record('download', linkRel, `shortcut to an ${kind}`);
    }

    private async recordLink(uid: string, linkRel: string) {
        const stat = await fs.stat(this.abs(linkRel));
        this.upsert({
            uid,
            type: 'link',
            rel_path: linkRel,
            revision_uid: null,
            local_size: stat.size,
            local_mtime_ms: Math.trunc(stat.mtimeMs),
            local_ino: stat.ino,
        });
    }

    private async download(node: NodeEntity, rel: string, revisionUid: string, mtime: Date) {
        const target = this.abs(rel);
        const part = path.join(path.dirname(target), `.${path.basename(target)}${PART_SUFFIX}`);
        let stream: WritableStream | undefined;
        try {
            await fs.mkdir(path.dirname(target), { recursive: true });
            const downloader = await this.client.getFileRevisionDownloader(revisionUid);
            const out = createWriteStream(part);
            stream = Writable.toWeb(out);
            const controller = downloader.downloadToStream(stream);
            await controller.completion();
            // The SDK only releases its writer when done; closing (which
            // flushes and closes the file) is up to us.
            const closed = once(out, 'close');
            await stream.close();
            await closed;
            stream = undefined;
            if (controller.isDownloadCompleteWithSignatureIssues()) {
                this.warn(`${rel}: downloaded, but its signature could not be verified`);
            }
            await fs.utimes(part, mtime, mtime);
            await fs.rename(part, target);
            const stat = await fs.stat(target);
            this.upsert({
                uid: node.uid,
                type: 'file',
                rel_path: rel,
                revision_uid: revisionUid,
                local_size: stat.size,
                local_mtime_ms: Math.trunc(stat.mtimeMs),
                local_ino: stat.ino,
            });
            this.downloaded++;
            this.clearReview(node.uid);
            this.record('download', rel);
        } catch (error) {
            // Release the file handle before removing the part file.
            await stream?.abort().catch(() => {});
            await fs.rm(part, { force: true });
            this.fail(rel, 'downloading', error);
        }
    }

    /** Renamed/moved on Drive: move our unedited local copy along. */
    /**
     * Renamed/moved on Drive: carry the local file along. A rename changes the
     * name, not the content, so local edits move with it (and stay protected:
     * the row still records what sync wrote, so a later Drive change goes to
     * review). A local copy the user deleted stays deleted.
     */
    private async moveFile(row: Row, rel: string): Promise<Row | undefined> {
        const moved = () => {
            this.db.prepare('UPDATE nodes SET rel_path = ? WHERE uid = ?').run(rel, row.uid);
            this.db.prepare('UPDATE review SET rel_path = ? WHERE uid = ?').run(rel, row.uid);
            return { ...row, rel_path: rel };
        };
        const from = await statOrNull(this.abs(row.rel_path));
        if (!from) return moved();
        if (!(await statOrNull(this.abs(rel)))) {
            await fs.mkdir(path.dirname(this.abs(rel)), { recursive: true });
            await fs.rename(this.abs(row.rel_path), this.abs(rel));
            this.record('move', rel, row.rel_path);
            return moved();
        }
        // The new name is taken by another local file: leave both alone and
        // treat the Drive file as new (it will go to review, not overwrite).
        this.warn(`${row.rel_path}: renamed on Drive to ${rel}, but a local file already has that name; left as is`);
        this.leaveBehind([row], 'rename-clash');
        this.db.prepare('DELETE FROM nodes WHERE uid = ?').run(row.uid);
        return undefined;
    }

    private async moveFolder(oldRel: string, rel: string) {
        const descendants = (this.db.prepare('SELECT * FROM nodes').all() as Row[]).filter((r) =>
            isUnder(r.rel_path, oldRel),
        );
        if ((await statOrNull(this.abs(oldRel))) && !(await statOrNull(this.abs(rel)))) {
            await fs.mkdir(path.dirname(this.abs(rel)), { recursive: true });
            await fs.rename(this.abs(oldRel), this.abs(rel));
            const update = this.db.prepare('UPDATE nodes SET rel_path = ? WHERE uid = ?');
            const updateReview = this.db.prepare('UPDATE review SET rel_path = ? WHERE uid = ?');
            for (const r of descendants) {
                update.run(rel + r.rel_path.slice(oldRel.length), r.uid);
                updateReview.run(rel + r.rel_path.slice(oldRel.length), r.uid);
            }
            this.record('move', rel + '/', oldRel + '/');
            return;
        }
        // Can't move it cleanly: forget its contents so a rescan re-fetches
        // them into the new location; the old local folder is left untouched.
        this.leaveBehind(descendants, 'moved-on-drive');
        const forget = this.db.prepare('DELETE FROM nodes WHERE uid = ?');
        for (const r of descendants) forget.run(r.uid);
        this.needsRescan = true;
    }

    private removedRemotely(uid: string) {
        const row = this.getRow(uid);
        if (!row) return;
        const forget = this.db.prepare('DELETE FROM nodes WHERE uid = ?');
        const affected = [row];
        if (row.type === 'folder') {
            for (const r of this.db.prepare('SELECT * FROM nodes').all() as Row[]) {
                if (r.uid !== row.uid && isUnder(r.rel_path, row.rel_path)) affected.push(r);
            }
        }
        this.leaveBehind(affected, 'removed-on-drive');
        for (const r of affected) {
            if (r.uid === uid) continue;
            forget.run(r.uid);
            this.clearReview(r.uid);
        }
        forget.run(uid);
        this.clearReview(uid);
        this.record('removed', row.rel_path + (row.type === 'folder' ? '/' : ''), 'removed on Drive, kept locally');
    }

    private safeName(node: NodeEntity): string | null {
        if (!node.name.ok) {
            this.warn(`an item's name could not be decrypted, skipped (${node.uid})`);
            return null;
        }
        const name = node.name.value;
        // Names come from the server: never let one escape the mirror folder.
        if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
            this.warn(`unsafe name ${JSON.stringify(name)}, skipped (${node.uid})`);
            return null;
        }
        if (name.endsWith(PART_SUFFIX)) return null;
        return name;
    }

    private matches(row: Row, stat: { size: number; mtimeMs: number }) {
        return stat.size === row.local_size && Math.trunc(stat.mtimeMs) === row.local_mtime_ms;
    }

    private abs(rel: string) {
        return path.join(this.root, rel);
    }

    private getRow(uid: string) {
        return this.db.prepare('SELECT * FROM nodes WHERE uid = ?').get(uid) as Row | undefined;
    }

    private upsert(r: Row) {
        this.db
            .prepare(
                `INSERT INTO nodes (uid, type, rel_path, revision_uid, local_size, local_mtime_ms, local_ino)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(uid) DO UPDATE SET type = excluded.type, rel_path = excluded.rel_path,
                     revision_uid = excluded.revision_uid, local_size = excluded.local_size,
                     local_mtime_ms = excluded.local_mtime_ms,
                     local_ino = COALESCE(excluded.local_ino, nodes.local_ino)`,
            )
            .run(r.uid, r.type, r.rel_path, r.revision_uid, r.local_size, r.local_mtime_ms, r.local_ino ?? null);
        // Sync owns this path again.
        this.db.prepare('DELETE FROM leftovers WHERE rel_path = ?').run(r.rel_path);
    }

    private needsReview(
        uid: string,
        rel: string,
        reason: 'local-edit' | 'local-exists',
        revisionUid: string,
        drive: { mtimeMs: number; size: number | null },
    ) {
        const known = this.db.prepare('SELECT revision_uid, dismissed FROM review WHERE uid = ?').get(uid) as
            | { revision_uid: string; dismissed: number }
            | undefined;
        // "Keep mine" was chosen for this exact Drive version: stay quiet.
        if (known?.dismissed && known.revision_uid === revisionUid) return;
        this.db
            .prepare(
                `INSERT INTO review (uid, rel_path, reason, revision_uid, time_ms, dismissed, drive_mtime_ms, drive_size)
                 VALUES (?, ?, ?, ?, ?, 0, ?, ?)
                 ON CONFLICT(uid) DO UPDATE SET rel_path = excluded.rel_path, reason = excluded.reason,
                     revision_uid = excluded.revision_uid, time_ms = excluded.time_ms, dismissed = 0,
                     drive_mtime_ms = excluded.drive_mtime_ms, drive_size = excluded.drive_size`,
            )
            .run(uid, rel, reason, revisionUid, Date.now(), drive.mtimeMs, drive.size);
        this.skipped++;
        this.record(
            'skipped',
            rel,
            reason === 'local-edit'
                ? 'changed on Drive, but the local copy was edited; not overwriting'
                : 'a local file with this name already exists (not made by sync); not overwriting',
        );
    }

    /**
     * A review item whose local file has gone (moved away or deleted) is no
     * longer a clash: drop it, and fetch the Drive file into the now-free spot
     * when the clash was with a file sync never owned. (A deleted *edited*
     * copy is left to the normal rules.) Includes "keep mine" items.
     */
    private async recheckReview() {
        const items = this.db.prepare('SELECT uid, rel_path, reason FROM review').all() as {
            uid: string;
            rel_path: string;
            reason: string;
        }[];
        for (const item of items) {
            if (await statOrNull(this.abs(item.rel_path))) continue;
            this.clearReview(item.uid);
            this.record('resolved', item.rel_path, 'the local file moved away, so there is no clash any more');
            if (item.reason === 'local-exists') await this.syncByUid(item.uid);
        }
    }

    /** Fill in Drive-side details for review items recorded before they were stored. */
    async fillReviewDetails() {
        const missing = this.db.prepare('SELECT uid FROM review WHERE dismissed = 0 AND drive_mtime_ms IS NULL').all() as {
            uid: string;
        }[];
        for (const { uid } of missing) {
            const node = await this.client.getNode(uid);
            const revision = node.activeRevision;
            this.db
                .prepare('UPDATE review SET drive_mtime_ms = ?, drive_size = ? WHERE uid = ?')
                .run((revision?.claimedModificationTime ?? node.modificationTime).getTime(), revision?.claimedSize ?? null, uid);
        }
    }

    /** Remember local copies sync stops tracking (unedited files, and folders). */
    private leaveBehind(rows: Row[], reason: 'removed-on-drive' | 'rename-clash' | 'moved-on-drive') {
        const insert = this.db.prepare(
            `INSERT INTO leftovers (rel_path, type, size, mtime_ms, reason, time_ms) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(rel_path) DO UPDATE SET type = excluded.type, size = excluded.size,
                 mtime_ms = excluded.mtime_ms, reason = excluded.reason, time_ms = excluded.time_ms`,
        );
        for (const r of rows) {
            let stat;
            try {
                stat = statSync(this.abs(r.rel_path));
            } catch {
                continue; // Already gone locally.
            }
            // An edited file is the user's own work, not a leftover.
            if (r.type !== 'folder' && !this.matches(r, stat)) continue;
            // A shortcut left behind is a plain file to the planner.
            const isFolder = r.type === 'folder';
            insert.run(r.rel_path, isFolder ? 'folder' : 'file', isFolder ? null : stat.size, isFolder ? null : Math.trunc(stat.mtimeMs), reason, Date.now());
        }
    }

    private clearReview(uid: string) {
        this.db.prepare('DELETE FROM review WHERE uid = ?').run(uid);
    }

    /**
     * Resolve a review item. 'keep-local' stays quiet until Drive changes the
     * file again; 'keep-both' renames the local file aside (nothing is lost)
     * and then fetches the Drive version under the original name.
     */
    async resolve(uid: string, action: 'keep-local' | 'keep-both') {
        const item = this.db.prepare('SELECT * FROM review WHERE uid = ?').get(uid) as
            | { rel_path: string; revision_uid: string }
            | undefined;
        if (!item) throw new Error('That item is no longer waiting for review');

        if (action === 'keep-local') {
            this.db.prepare('UPDATE review SET dismissed = 1 WHERE uid = ?').run(uid);
            this.record('resolved', item.rel_path, 'kept the local version');
            return;
        }

        const target = this.abs(item.rel_path);
        if (await statOrNull(target)) {
            const aside = await this.asideName(target);
            await fs.rename(target, aside);
            this.record('resolved', item.rel_path, `local version kept as ${path.basename(aside)}`);
        }
        // The local file is gone from the target path, so this downloads.
        this.db.prepare('DELETE FROM nodes WHERE uid = ?').run(uid);
        const node = await this.client.getNode(uid);
        const revision = node.activeRevision;
        if (!revision) throw new Error('Drive has no finished version of this file');
        await this.download(node, item.rel_path, revision.uid, revision.claimedModificationTime ?? node.modificationTime);
        if (this.failures) throw new Error('Downloading the Drive version failed; your local file was kept (renamed)');
    }

    /** "name (local copy 2026-10-13 21.05).ext", unique in its folder. */
    private async asideName(target: string) {
        const ext = path.extname(target);
        const stem = target.slice(0, target.length - ext.length);
        // Local time, e.g. 2026-10-13 21.05 (no colons: awkward in file names).
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
        for (let i = 1; ; i++) {
            const candidate = `${stem} (local copy ${stamp}${i > 1 ? ` ${i}` : ''})${ext}`;
            if (!(await statOrNull(candidate))) return candidate;
        }
    }

    private record(kind: string, rel: string, detail?: string) {
        addActivity(this.db, kind, rel, detail);
        const symbol = { download: '↓', move: '→', removed: '✕', skipped: '!', failed: '✗', warning: '!', resolved: '✓' }[kind] ?? '·';
        const line = kind === 'move' ? `${symbol} ${detail}  →  ${rel}` : `${symbol} ${rel}${detail ? `: ${detail}` : ''}`;
        (kind === 'failed' ? console.error : kind === 'skipped' || kind === 'warning' ? console.warn : console.log)(line);
    }

    private warn(message: string) {
        // Callers pass "<path>: <what happened>" (or just a message).
        const at = message.indexOf(': ');
        if (at > 0) this.record('warning', message.slice(0, at), message.slice(at + 2));
        else this.record('warning', '', message);
    }

    private fail(rel: string, action: string, error: unknown) {
        this.failures++;
        this.record('failed', rel, `${action} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (verbose && error instanceof Error) console.error(error.stack);
    }
}
