// Folder pairs: which local folder syncs with which Drive folder.
//
// The original pair, My Files <-> a local folder, lives in the main database
// (as it always has). Each folder added from this computer pairs with its own
// folder under this computer's entry in Drive's "Computers" section, and keeps
// its records in a separate database file, so pairs never mix.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DeviceType, DriveEventType, type ProtonDriveClient } from '@protontech/drive-sdk';
import { getMeta, LAYOUT_VERSION, openState, setMeta, STATE_DIR } from './mirror.ts';

export type Pair = {
    /** 'myfiles' for the original pair, otherwise a random id. */
    id: string;
    kind: 'myfiles' | 'computer';
    /** Shown in the app and in activity, e.g. "My Files" or "Documents". */
    label: string;
    local: string;
    /** Drive folder (computer pairs only; My Files is looked up by the SDK). */
    remoteUid?: string;
    db: DatabaseSync;
};

const PAIRS_DIR = path.join(STATE_DIR, 'pairs');

export function ensurePairsTable(main: DatabaseSync) {
    main.exec(`
        CREATE TABLE IF NOT EXISTS pairs (
            id TEXT PRIMARY KEY,
            local TEXT NOT NULL UNIQUE,
            remote_uid TEXT NOT NULL,
            label TEXT NOT NULL,
            created_ms INTEGER NOT NULL
        );
    `);
}

/** All pairs, the My Files one first (if it has a folder). */
export function listPairs(main: DatabaseSync): Pair[] {
    ensurePairsTable(main);
    const pairs: Pair[] = [];
    const myFiles = getMeta(main, 'root_dir');
    if (myFiles) pairs.push({ id: 'myfiles', kind: 'myfiles', label: 'My Files', local: myFiles, db: main });
    const rows = main.prepare('SELECT * FROM pairs ORDER BY created_ms').all() as {
        id: string;
        local: string;
        remote_uid: string;
        label: string;
    }[];
    for (const r of rows) {
        pairs.push({
            id: r.id,
            kind: 'computer',
            label: r.label,
            local: r.local,
            remoteUid: r.remote_uid,
            db: openState(path.join(PAIRS_DIR, `${r.id}.db`)),
        });
    }
    return pairs;
}

const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

/** Why a folder can't be added (or null if it can). */
export function checkNewLocal(main: DatabaseSync, local: string): string | null {
    if (local === path.parse(local).root || local === os.homedir()) {
        return `Refusing to sync ${local} as a whole; pick a folder inside it.`;
    }
    if (overlaps(local, STATE_DIR)) return "That folder holds (or is inside) this app's own records.";
    const trash = getMeta(main, 'trash');
    if (trash && overlaps(local, trash)) return 'That folder overlaps the trash folder for Drive deletions.';
    for (const p of listPairs(main)) {
        if (overlaps(local, p.local)) return `That folder overlaps one that's already synced (${p.local}).`;
    }
    let stat;
    try {
        stat = fs.statSync(local);
    } catch {
        return `${local} doesn't exist.`;
    }
    if (!stat.isDirectory()) return `${local} isn't a folder.`;
    return null;
}

/** This computer's entry under "Computers" on Drive, created on first use. */
export async function computerDevice(main: DatabaseSync, client: ProtonDriveClient) {
    const known = getMeta(main, 'device_uid');
    for await (const device of client.iterateDevices()) {
        if (device.uid === known) return device;
    }
    // Not created yet (or deleted on Drive since): make one, named after the PC.
    const device = await client.createDevice(os.hostname(), DeviceType.Linux);
    setMeta(main, 'device_uid', device.uid);
    return device;
}

/**
 * Pair a local folder with a new folder under this computer on Drive (named
 * like the local folder; a number is added if that name is taken there).
 * Nothing is copied yet: the next sync run does that.
 */
export async function addPair(main: DatabaseSync, client: ProtonDriveClient, localDir: string) {
    const local = path.resolve(localDir);
    const problem = checkNewLocal(main, local);
    if (problem) throw new Error(problem);

    const device = await computerDevice(main, client);
    const taken = new Set<string>();
    for await (const child of client.iterateFolderChildren(device.rootFolderUid)) {
        if (child.name.ok) taken.add(child.name.value);
    }
    const base = path.basename(local);
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;
    const folder = await client.createFolder(device.rootFolderUid, name);

    ensurePairsTable(main);
    const id = randomUUID().slice(0, 8);
    main.prepare('INSERT INTO pairs (id, local, remote_uid, label, created_ms) VALUES (?, ?, ?, ?, ?)').run(
        id,
        local,
        folder.uid,
        name,
        Date.now(),
    );
    // The pair's own records; the folder is fixed for its lifetime. The Drive
    // folder was just created empty, so there is nothing to scan there: start
    // following Drive's changes from now on (the first sync only uploads).
    const db = openState(path.join(PAIRS_DIR, `${id}.db`));
    setMeta(db, 'root_dir', local);
    for await (const event of client.iterateEvents(folder.treeEventScopeId)) {
        if (event.type === DriveEventType.FastForward) {
            setMeta(db, 'scope', folder.treeEventScopeId);
            setMeta(db, 'event_id', event.eventId);
            setMeta(db, 'layout', LAYOUT_VERSION);
        }
    }
    return { id, name, deviceName: device.name.ok ? device.name.value : os.hostname() };
}

/** Stop syncing a pair. Its local folder and its copy on Drive both stay. */
export function removePair(main: DatabaseSync, idOrLocal: string) {
    ensurePairsTable(main);
    const local = path.resolve(idOrLocal);
    const row = main.prepare('SELECT id, local FROM pairs WHERE id = ? OR local = ?').get(idOrLocal, local) as
        | { id: string; local: string }
        | undefined;
    if (!row) throw new Error(`No synced folder ${idOrLocal}`);
    main.prepare('DELETE FROM pairs WHERE id = ?').run(row.id);
    fs.rmSync(path.join(PAIRS_DIR, `${row.id}.db`), { force: true });
    return row.local;
}

/**
 * Logging in as a different account: forget everything tied to the previous
 * one (folder pairings, sync records, this PC's device), so nothing of the
 * old account's folders gets synced into the new one. Uploads are switched
 * off for a cautious start. Files are untouched, here and on both Drives;
 * preferences (trash folder, interval) are kept.
 */
export function startFreshForNewAccount(main: DatabaseSync) {
    ensurePairsTable(main);
    for (const { id } of main.prepare('SELECT id FROM pairs').all() as { id: string }[]) {
        fs.rmSync(path.join(PAIRS_DIR, `${id}.db`), { force: true });
    }
    main.exec(`
        DELETE FROM pairs; DELETE FROM nodes; DELETE FROM review; DELETE FROM leftovers;
        DELETE FROM activity; DELETE FROM runs;
        DELETE FROM meta WHERE key IN ('root_dir', 'event_id', 'scope', 'layout', 'account', 'device_uid',
            'mass_delete_held', 'space_waiting', 'storage', 'progress', 'exclude', 'exclude_defaults');
    `);
    setMeta(main, 'uploads', '');
}
