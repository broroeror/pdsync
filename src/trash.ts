// Where local copies go when their file is deleted on Drive: the desktop trash
// (restorable from the file manager) or a folder the user chose, e.g. on a
// big backup drive. Nothing is ever deleted outright.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

const run = promisify(execFile);

export type TrashTarget = { kind: 'desktop' } | { kind: 'folder'; dir: string };
export type TrashResult = { ok: true; where: string } | { ok: false; why: string };

export function trashTarget(db: DatabaseSync): TrashTarget {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'trash'").get() as { value: string } | undefined;
    return row?.value ? { kind: 'folder', dir: row.value } : { kind: 'desktop' };
}

export function describeTrash(target: TrashTarget) {
    return target.kind === 'desktop' ? 'your desktop trash' : target.dir;
}

/**
 * Validate and create a chosen trash folder. Refuses a folder under a drive's
 * mount point (/mnt/X, /media/X, /run/media/<user>/X) when that drive isn't
 * mounted, since the folder would land on the system disk instead.
 */
export async function prepareTrashFolder(dir: string, mirrorRoot: string | undefined) {
    const resolved = path.resolve(dir);
    if (mirrorRoot && (resolved === mirrorRoot || resolved.startsWith(mirrorRoot + '/') || mirrorRoot.startsWith(resolved + '/'))) {
        throw new Error('The trash folder must be outside the mirror folder (and not contain it).');
    }
    await assertMounted(resolved);
    await fs.mkdir(resolved, { recursive: true });
    return resolved;
}

/**
 * Refuse a path under a drive's mount point (/mnt/X, /media/X,
 * /run/media/<user>/X) when that drive isn't mounted: the mount point is then
 * an empty folder on the system disk, and anything put there lands on the
 * wrong drive.
 */
export async function assertMounted(resolved: string) {
    const parts = resolved.split('/');
    const mountDepth = parts[1] === 'run' && parts[2] === 'media' ? 5 : parts[1] === 'mnt' || parts[1] === 'media' ? 3 : 0;
    if (mountDepth && parts.length >= mountDepth) {
        const mountPoint = parts.slice(0, mountDepth).join('/');
        const [mp, parent] = await Promise.all([fs.stat(mountPoint).catch(() => null), fs.stat(path.dirname(mountPoint))]);
        if (!mp || mp.dev === parent.dev) {
            throw new Error(`${mountPoint} doesn't look mounted right now; plug in / mount the drive and try again.`);
        }
    }
}

/** "2026-10-14 01.05" (local time; no colons, which NTFS and others reject). */
function stamp() {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
}

/** Total bytes and file count under a path, to verify a cross-drive copy. */
export async function measure(p: string): Promise<{ bytes: number; files: number }> {
    const stat = await fs.lstat(p);
    if (!stat.isDirectory()) return { bytes: stat.size, files: 1 };
    let bytes = 0;
    let files = 0;
    for (const name of await fs.readdir(p)) {
        const sub = await measure(path.join(p, name));
        bytes += sub.bytes;
        files += sub.files;
    }
    return { bytes, files };
}

/**
 * Move a local file or folder to the trash. `rel` (its path inside the mirror)
 * is kept under a dated folder in a custom trash, so it's easy to put back.
 */
export async function moveToTrash(abs: string, rel: string, target: TrashTarget): Promise<TrashResult> {
    if (target.kind === 'desktop') {
        try {
            await run('gio', ['trash', '--', abs]);
            return { ok: true, where: 'your desktop trash' };
        } catch (error) {
            return { ok: false, why: `the desktop trash refused it (${(error as Error).message.split('\n')[0]})` };
        }
    }

    // The folder must already exist: when a drive isn't mounted its mount
    // point is an empty folder on the system disk, and creating the trash
    // there would quietly fill the wrong drive.
    const dirStat = await fs.stat(target.dir).catch(() => null);
    if (!dirStat?.isDirectory()) {
        return { ok: false, why: `the trash folder ${target.dir} isn't available (drive not mounted?)` };
    }
    let dest = path.join(target.dir, stamp(), rel);
    for (let i = 2; await fs.lstat(dest).then(() => true, () => false); i++) {
        dest = path.join(target.dir, stamp(), `${rel} (${i})`);
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });

    try {
        await fs.rename(abs, dest);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
            return { ok: false, why: `couldn't move it to ${target.dir} (${(error as Error).message})` };
        }
        // Another drive: copy, check the copy is complete, then remove the original.
        try {
            await fs.cp(abs, dest, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
            const [from, to] = await Promise.all([measure(abs), measure(dest)]);
            if (from.bytes !== to.bytes || from.files !== to.files) throw new Error('the copy came out incomplete');
        } catch (copyError) {
            await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
            return { ok: false, why: `couldn't copy it to ${target.dir} (${(copyError as Error).message})` };
        }
        await fs.rm(abs, { recursive: true });
    }
    return { ok: true, where: target.dir };
}
