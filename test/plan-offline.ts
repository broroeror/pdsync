// Offline check of the upload planner against a scratch folder.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const scratch = await fs.mkdtemp(path.join(process.env.PDSYNC_TEST_TMP || os.tmpdir(), 'pdsync-plan-'));
process.env.XDG_STATE_HOME = path.join(scratch, 'state');
const { openState } = await import('../src/mirror.ts');
const { planUploads } = await import('../src/plan.ts');

const root = path.join(scratch, 'mirror');
const db = openState();
const abs = (rel: string) => path.join(root, rel);
let uidSeq = 0;

/** A file/folder as sync would have left it, with its state row. */
async function synced(rel: string, content?: string, opts: { noIno?: boolean } = {}) {
    await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
    if (content === undefined) await fs.mkdir(abs(rel), { recursive: true });
    else await fs.writeFile(abs(rel), content);
    const st = await fs.stat(abs(rel));
    const uid = `u${++uidSeq}`;
    db.prepare(
        'INSERT INTO nodes (uid, type, rel_path, revision_uid, local_size, local_mtime_ms, local_ino) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
        uid,
        content === undefined ? 'folder' : 'file',
        rel,
        content === undefined ? null : `${uid}-r1`,
        content === undefined ? null : st.size,
        content === undefined ? null : Math.trunc(st.mtimeMs),
        opts.noIno ? null : st.ino,
    );
    return uid;
}
const summary = async () =>
    (await planUploads(db, root)).items.map((i) =>
        i.action === 'move' ? `move ${i.from} -> ${i.to}` : i.action === 'trash' ? `trash ${i.rel} (${i.files})` : `${i.action} ${i.rel}`,
    );
const reset = async () => {
    db.exec('DELETE FROM nodes; DELETE FROM review;');
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
};

// 1. Untouched: nothing to do.
await reset();
await synced('Docs');
await synced('Docs/a.txt', 'A');
await synced('b.txt', 'B');
assert.deepEqual(await summary(), []);
console.log('✓ untouched folder plans nothing');

// 2. New folder with a file, and a new top-level file.
await fs.mkdir(abs('New'));
await fs.writeFile(abs('New/n.txt'), 'N');
await fs.writeFile(abs('c.txt'), 'C');
assert.deepEqual(await summary(), ['create-folder New', 'upload c.txt', 'upload New/n.txt']);
console.log('✓ new files and folders are uploaded (folders first)');

// 3. Edit + rename + delete.
await reset();
await synced('a.txt', 'A');
await synced('b.txt', 'B');
await synced('gone.txt', 'G');
await fs.appendFile(abs('a.txt'), ' edited');
await fs.rename(abs('b.txt'), abs('b-renamed.txt'));
await fs.rm(abs('gone.txt'));
assert.deepEqual(await summary(), ['move b.txt -> b-renamed.txt', 'update a.txt', 'trash gone.txt (1)']);
console.log('✓ edit, rename (not delete + upload) and delete');

// 4. A moved folder is one move; an edit inside it is an update at the new path.
await reset();
await synced('Projects');
await synced('Projects/x.txt', 'X');
await synced('Projects/y.txt', 'Y');
await fs.mkdir(abs('Archive'));
await synced('Archive/keep.txt', 'K');
await fs.rename(abs('Projects'), abs('Archive/Projects-2025'));
await fs.appendFile(abs('Archive/Projects-2025/x.txt'), '!');
assert.deepEqual(await summary(), [
    'create-folder Archive',
    'move Projects -> Archive/Projects-2025',
    'update Archive/Projects-2025/x.txt',
]);
console.log('✓ folder move carries its contents; edits inside still upload');

// 5. Deleting a folder trashes it once, not file by file.
await reset();
await synced('Old');
for (const f of ['1', '2', '3']) await synced(`Old/${f}.txt`, f);
for (const f of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) await synced(`${f}.txt`, f);
await fs.rm(abs('Old'), { recursive: true });
assert.deepEqual(await summary(), ['trash Old (3)']);
console.log('✓ a deleted folder is one trash action');

// 6. Mass deletion is held for confirmation, not trashed.
for (const f of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) await fs.rm(abs(`${f}.txt`));
const mass = await planUploads(db, root);
assert.equal(mass.items.filter((i) => i.action === 'trash').length, 0);
assert.match(mass.held[0].why, /13 files are gone/);
console.log('✓ many deletions at once are held for confirmation');

// 7. Editor scratch files, our part files, Dolphin's .directory and symlinks are ignored.
await reset();
await synced('doc.odt', 'D');
for (const junk of ['.~lock.doc.odt#', 'notes.txt~', '.notes.txt.swp', '.x.pdsync-part', '.directory']) {
    await fs.writeFile(abs(junk), 'junk');
}
await fs.symlink('/etc/hostname', abs('link'));
assert.deepEqual(await summary(), []);
console.log('✓ temp files, part files and symlinks are ignored');

// 8. Files waiting in Review are held, both kinds.
await reset();
const edited = await synced('conflict.txt', 'v1');
await fs.appendFile(abs('conflict.txt'), ' local');
db.prepare("INSERT INTO review (uid, rel_path, reason, revision_uid, time_ms) VALUES (?, 'conflict.txt', 'local-edit', 'r2', 0)").run(edited);
await fs.writeFile(abs('clash.txt'), 'mine');
db.prepare("INSERT INTO review (uid, rel_path, reason, revision_uid, time_ms) VALUES ('drive-uid', 'clash.txt', 'local-exists', 'r1', 0)").run();
const held = await planUploads(db, root);
assert.deepEqual(held.items, []);
assert.deepEqual(held.held.map((h) => h.rel).sort(), ['clash.txt', 'conflict.txt']);
console.log('✓ Review items are held back');

// 9. Older rows without an inode: a rename is still recognised by size + mtime.
await reset();
await synced('old-row.txt', 'some content', { noIno: true });
await fs.rename(abs('old-row.txt'), abs('old-row-renamed.txt'));
assert.deepEqual(await summary(), ['move old-row.txt -> old-row-renamed.txt']);
console.log('✓ rename detected for rows recorded before inodes');

// 9b. Renamed *and* edited: not trusted as a rename (inodes can be reused),
// so it's the safe pair: old one to trash, new one uploaded.
await reset();
await synced('draft.txt', 'v1');
await synced('other.txt', 'O');
await fs.rename(abs('draft.txt'), abs('final.txt'));
await fs.appendFile(abs('final.txt'), ' and more');
assert.deepEqual(await summary(), ['upload final.txt', 'trash draft.txt (1)']);
console.log('✓ renamed + edited becomes trash + upload, never a bogus rename');

// 10. A missing or empty folder blocks everything (unmounted drive).
await reset();
await synced('a.txt', 'A');
await fs.rm(abs('a.txt'));
assert.match((await planUploads(db, root)).blocked ?? '', /is empty/);
await fs.rm(root, { recursive: true });
assert.match((await planUploads(db, root)).blocked ?? '', /is missing/);
console.log('✓ missing or empty folder blocks all changes');

await fs.rm(scratch, { recursive: true, force: true });
console.log('\nall planner checks passed');
