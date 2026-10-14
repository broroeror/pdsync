// Offline check of the mirror's safety rules against an in-memory fake Drive.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const scratch = await fs.mkdtemp(path.join(process.env.PDSYNC_TEST_TMP || os.tmpdir(), 'pdsync-test-'));
process.env.XDG_STATE_HOME = path.join(scratch, 'state');
const { Mirror, openState } = await import('../src/mirror.ts');

type FakeNode = { uid: string; parentUid?: string; name: string; type: 'file' | 'folder'; rev?: string; content?: string; trashed?: boolean; mediaType?: string };

class FakeDrive {
    nodes = new Map<string, FakeNode>();
    events: any[] = [];
    failDownloads = false;
    private seq = 0;

    constructor() {
        this.nodes.set('root', { uid: 'root', name: 'root', type: 'folder' });
    }
    add(n: FakeNode) {
        this.nodes.set(n.uid, n);
        this.emit('node_created', n.uid);
    }
    update(uid: string, change: Partial<FakeNode>) {
        Object.assign(this.nodes.get(uid)!, change);
        this.emit('node_updated', uid);
    }
    emit(type: string, nodeUid: string) {
        const n = this.nodes.get(nodeUid)!;
        this.events.push({ type, nodeUid, isTrashed: !!n.trashed, eventId: `e${++this.seq}`, treeEventScopeId: 'vol' });
    }
    entity(n: FakeNode): any {
        return {
            uid: n.uid,
            parentUid: n.parentUid,
            name: { ok: true, value: n.name },
            type: n.type,
            mediaType: n.mediaType,
            trashTime: n.trashed ? new Date() : undefined,
            modificationTime: new Date('2025-01-02T03:04:05Z'),
            treeEventScopeId: 'vol',
            activeRevision: n.type === 'file' ? { uid: n.rev, claimedModificationTime: new Date('2025-01-02T03:04:05Z') } : undefined,
        };
    }
    client(): any {
        return {
            experimental: { getNodeUrl: async (uid: string) => `https://docs.example/open/${uid}` },
            getMyFilesRootFolder: async () => this.entity(this.nodes.get('root')!),
            getNode: async (uid: string) => this.entity(this.nodes.get(uid)!),
            iterateFolderChildren: async function* (this: FakeDrive, uid: string) {
                for (const n of this.nodes.values()) if (n.parentUid === uid) yield this.entity(n);
            }.bind(this),
            iterateEvents: async function* (this: FakeDrive, _scope: string, last?: string) {
                if (!last) {
                    yield { type: 'fast_forward', eventId: `e${this.seq}`, treeEventScopeId: 'vol' };
                    return;
                }
                const from = Number(last.slice(1));
                for (const e of this.events) if (Number(e.eventId.slice(1)) > from) yield e;
            }.bind(this),
            getFileRevisionDownloader: async (revUid: string) => {
                const node = [...this.nodes.values()].find((n) => n.rev === revUid)!;
                const fail = this.failDownloads;
                return {
                    downloadToStream: (stream: WritableStream) => {
                        const done = (async () => {
                            // Like the real SDK: write, then release the lock
                            // without closing; on failure, release and throw.
                            const writer = stream.getWriter();
                            await writer.write(new TextEncoder().encode(node.content!));
                            writer.releaseLock();
                            if (fail) throw new Error('network went away');
                        })();
                        return { completion: () => done, isDownloadCompleteWithSignatureIssues: () => false };
                    },
                };
            },
        };
    }
}

const root = path.join(scratch, 'mirror');
const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');
const exists = (rel: string) => fs.stat(path.join(root, rel)).then(() => true, () => false);
const drive = new FakeDrive();
const db = openState();
const run = async (opts = {}) => {
    const m = new Mirror(drive.client(), db, root);
    await m.run(opts);
    return m;
};

// 1. First run: full walk downloads the tree, with Drive's modification time.
drive.add({ uid: 'docs', parentUid: 'root', name: 'Docs', type: 'folder' });
drive.add({ uid: 'a', parentUid: 'docs', name: 'a.txt', type: 'file', rev: 'a1', content: 'A v1' });
drive.add({ uid: 'b', parentUid: 'root', name: 'b.txt', type: 'file', rev: 'b1', content: 'B v1' });
drive.add({ uid: 'evil', parentUid: 'root', name: '../escape.txt', type: 'file', rev: 'x1', content: 'nope' });
let m = await run();
assert.equal(await read('Docs/a.txt'), 'A v1');
assert.equal(await read('b.txt'), 'B v1');
assert.equal((await fs.stat(path.join(root, 'b.txt'))).mtime.toISOString(), '2025-01-02T03:04:05.000Z');
assert.equal(await fs.stat(path.join(scratch, 'escape.txt')).then(() => true, () => false), false, 'unsafe name escaped');
assert.equal(m.downloaded, 2);
console.log('✓ full walk, mtime, unsafe name blocked');

// 2. Second run with nothing new downloads nothing.
m = await run();
assert.equal(m.downloaded, 0);
console.log('✓ no-op run');

// 3. New revision of an unedited file is re-downloaded.
drive.update('b', { rev: 'b2', content: 'B v2' });
m = await run();
assert.equal(await read('b.txt'), 'B v2');
console.log('✓ remote update applied');

// 4. Local edit + remote update: local edit is kept, not overwritten.
await fs.writeFile(path.join(root, 'b.txt'), 'MY LOCAL EDIT, longer');
drive.update('b', { rev: 'b3', content: 'B v3' });
m = await run();
assert.equal(await read('b.txt'), 'MY LOCAL EDIT, longer');
assert.equal(m.skipped, 1);
console.log('✓ local edit protected');

// 5. A local file the mirror didn't create is never overwritten.
await fs.writeFile(path.join(root, 'c.txt'), 'pre-existing local file');
drive.add({ uid: 'c', parentUid: 'root', name: 'c.txt', type: 'file', rev: 'c1', content: 'C from Drive' });
m = await run();
assert.equal(await read('c.txt'), 'pre-existing local file');
console.log('✓ foreign local file protected');

// 6. Rename a file and a folder: local copies move along, contents intact.
drive.update('a', { name: 'renamed.txt' });
drive.update('docs', { name: 'Documents' });
m = await run();
assert.equal(await read('Documents/renamed.txt'), 'A v1');
assert.equal(await exists('Docs'), false);
assert.equal(m.downloaded, 0, 'renames should move, not re-download');
console.log('✓ file + folder renames move local copies');

// 6b. Renaming a locally *edited* file moves it with the edit intact, no copy.
drive.add({ uid: 'e', parentUid: 'root', name: 'edited.txt', type: 'file', rev: 'e1', content: 'E v1' });
await run();
await fs.writeFile(path.join(root, 'edited.txt'), 'E v1 plus my local line');
drive.update('e', { name: 'edited-renamed.txt' });
m = await run();
assert.equal(await read('edited-renamed.txt'), 'E v1 plus my local line');
assert.equal(await exists('edited.txt'), false);
assert.equal(m.downloaded, 0, 'no duplicate download');
// ...and the edit stays protected when Drive later changes the file.
drive.update('e', { rev: 'e2', content: 'E v2' });
m = await run();
assert.equal(await read('edited-renamed.txt'), 'E v1 plus my local line');
assert.equal(m.skipped, 1);
await new Mirror(drive.client(), db, root).resolve('e', 'keep-local');
console.log('✓ rename carries a locally edited file along, edit still protected');

// 6c. Renaming a file whose local copy was deleted doesn't bring it back.
drive.add({ uid: 'g', parentUid: 'root', name: 'gone.txt', type: 'file', rev: 'g1', content: 'G' });
await run();
await fs.rm(path.join(root, 'gone.txt'));
drive.update('g', { name: 'gone-renamed.txt' });
m = await run();
assert.equal(await exists('gone-renamed.txt'), false);
assert.equal(m.downloaded, 0);
console.log('✓ rename does not resurrect a locally deleted file');

// 7. Trashed on Drive: kept locally.
drive.update('a', { trashed: true });
m = await run();
assert.equal(await read('Documents/renamed.txt'), 'A v1');
console.log('✓ remote trash keeps the local file');

// 8. A failed download leaves no part file and does not advance the cursor.
drive.add({ uid: 'd', parentUid: 'root', name: 'd.txt', type: 'file', rev: 'd1', content: 'D' });
drive.failDownloads = true;
m = await run();
assert.equal(m.failures, 1);
assert.equal(await exists('d.txt'), false);
assert.deepEqual((await fs.readdir(root)).filter((f) => f.endsWith('.pdsync-part')), []);
drive.failDownloads = false;
m = await run();
assert.equal(await read('d.txt'), 'D', 'retried after failure');
console.log('✓ failed download cleaned up and retried');

// 9. The state refuses to be reused for a different folder.
await assert.rejects(new Mirror(drive.client(), db, path.join(scratch, 'other')).run(), /belongs to a mirror/);
console.log('✓ state tied to its folder');

// 10. Skipped files land in the review list with the right reason.
const reviewRows = () => db.prepare('SELECT uid, reason, dismissed FROM review ORDER BY uid').all() as any[];
assert.deepEqual(
    reviewRows().map((r) => [r.uid, r.reason, r.dismissed]),
    [['b', 'local-edit', 0], ['c', 'local-exists', 0], ['e', 'local-edit', 1]],
);
console.log('✓ skipped files listed for review');

// 11. "Keep mine": no more warnings for this Drive version...
await new Mirror(drive.client(), db, root).resolve('b', 'keep-local');
m = await run({ full: true });
assert.equal(m.skipped, 1, 'only c should still warn');
assert.equal(await read('b.txt'), 'MY LOCAL EDIT, longer');
// ...but a newer Drive version asks again, still without overwriting.
drive.update('b', { rev: 'b4', content: 'B v4' });
m = await run();
assert.equal(await read('b.txt'), 'MY LOCAL EDIT, longer');
assert.deepEqual({ ...reviewRows().find((r) => r.uid === 'b') }, { uid: 'b', reason: 'local-edit', dismissed: 0 });
console.log('✓ keep-local stays quiet until Drive changes again');

// 12. "Keep both": the local file is renamed aside, the Drive version fetched.
await new Mirror(drive.client(), db, root).resolve('c', 'keep-both');
assert.equal(await read('c.txt'), 'C from Drive');
const aside = (await fs.readdir(root)).find((f) => f.startsWith('c (local copy '));
assert.ok(aside, 'local copy kept');
assert.equal(await read(aside!), 'pre-existing local file');
assert.equal(reviewRows().some((r) => r.uid === 'c'), false);
console.log('✓ keep-both keeps the local file and fetches the Drive one');

// 13. Every action was recorded for the activity view.
const kinds = new Set((db.prepare('SELECT kind FROM activity').all() as any[]).map((r) => r.kind));
for (const k of ['download', 'move', 'removed', 'skipped', 'failed', 'resolved']) assert.ok(kinds.has(k), `missing ${k}`);
console.log('✓ activity recorded');

// 14. Copies sync stops tracking are remembered as leftovers, and the upload
// planner holds them instead of uploading them back.
const { planUploads } = await import('../src/plan.ts');
const leftovers = () => (db.prepare('SELECT rel_path, reason FROM leftovers ORDER BY rel_path').all() as any[]).map((r) => `${r.rel_path}:${r.reason}`);
drive.add({ uid: 'h', parentUid: 'root', name: 'drive-deletes-me.txt', type: 'file', rev: 'h1', content: 'H' });
await run();
drive.update('h', { trashed: true });
await run();
assert.ok(leftovers().includes('drive-deletes-me.txt:removed-on-drive'));
let plan = await planUploads(db, root);
assert.ok(!plan.items.some((i) => i.action === 'upload' && i.rel === 'drive-deletes-me.txt'), 'must not re-upload a Drive deletion');
assert.ok(plan.held.some((h) => h.rel === 'drive-deletes-me.txt'));
// Edited afterwards, it's the user's own file again: upload it.
await fs.writeFile(path.join(root, 'drive-deletes-me.txt'), 'H, but I kept working on it');
plan = await planUploads(db, root);
assert.ok(plan.items.some((i) => i.action === 'upload' && i.rel === 'drive-deletes-me.txt'));
console.log('✓ Drive deletions are not re-uploaded (unless edited afterwards)');

// A rename on Drive into a name that's taken leaves the old copy as a leftover.
drive.add({ uid: 'k', parentUid: 'root', name: 'k-old.txt', type: 'file', rev: 'k1', content: 'K' });
await run();
await fs.writeFile(path.join(root, 'k-new.txt'), 'unrelated local file');
drive.update('k', { name: 'k-new.txt' });
await run();
assert.ok(leftovers().includes('k-old.txt:rename-clash'));
plan = await planUploads(db, root);
assert.ok(!plan.items.some((i) => i.action === 'upload' && i.rel === 'k-old.txt'));
console.log('✓ a copy left behind by a rename clash is not uploaded');

// 15. A clash ends when the local file moves away: the Drive file then arrives,
// even if "keep mine" was chosen earlier.
await fs.writeFile(path.join(root, 'spot.txt'), 'my own file');
drive.add({ uid: 'm', parentUid: 'root', name: 'spot.txt', type: 'file', rev: 'm1', content: 'Drive spot' });
await run();
assert.ok(reviewRows().some((r) => r.uid === 'm'));
await new Mirror(drive.client(), db, root).resolve('m', 'keep-local');
await fs.mkdir(path.join(root, 'Elsewhere'), { recursive: true });
await fs.rename(path.join(root, 'spot.txt'), path.join(root, 'Elsewhere/spot.txt'));
m = await run();
assert.equal(await read('spot.txt'), 'Drive spot');
assert.equal(await read('Elsewhere/spot.txt'), 'my own file');
assert.ok(!reviewRows().some((r) => r.uid === 'm'));
console.log('✓ moving the local file away ends the clash and fetches the Drive file');

// 16. Online documents (Proton Docs/Sheets) become shortcuts, never files.
const DOC = 'application/vnd.proton.doc';
drive.add({ uid: 'doc1', parentUid: 'root', name: 'Sample File', type: 'file', rev: 'd1', content: '', mediaType: DOC });
await run();
assert.equal(await exists('Sample File'), false, 'no empty placeholder');
const shortcut = await read('Sample File.desktop');
assert.match(shortcut, /^Type=Link$/m);
assert.match(shortcut, /^Name=Sample File$/m);
assert.match(shortcut, /^URL=https:\/\/docs\.example\/open\/doc1$/m);
console.log('✓ an online document becomes a shortcut that opens it');

drive.update('doc1', { name: 'Renamed Doc' });
await run();
assert.equal(await exists('Sample File.desktop'), false);
assert.match(await read('Renamed Doc.desktop'), /^Name=Renamed Doc$/m);
console.log('✓ renaming the document on Drive moves its shortcut');

// Shortcuts are never uploaded, and deleting one never trashes the document.
plan = await planUploads(db, root);
assert.ok(!plan.items.some((i) => 'rel' in i && i.rel.endsWith('.desktop')));
await fs.rm(path.join(root, 'Renamed Doc.desktop'));
plan = await planUploads(db, root);
assert.ok(!plan.items.some((i) => i.action === 'trash' && i.uid === 'doc1'));
console.log('✓ the planner never uploads or trashes a shortcut');

// Upgrade: an empty placeholder written by an older version becomes a shortcut.
await fs.writeFile(path.join(root, 'Old Doc'), '');
const st = await fs.stat(path.join(root, 'Old Doc'));
drive.nodes.set('doc2', { uid: 'doc2', parentUid: 'root', name: 'Old Doc', type: 'file', rev: 'o1', content: '', mediaType: DOC });
db.prepare("INSERT INTO nodes (uid, type, rel_path, revision_uid, local_size, local_mtime_ms) VALUES ('doc2', 'file', 'Old Doc', 'o1', 0, ?)").run(Math.trunc(st.mtimeMs));
db.prepare("UPDATE meta SET value = '1' WHERE key = 'layout'").run();
await run();
assert.equal(await exists('Old Doc'), false);
assert.match(await read('Old Doc.desktop'), /^Name=Old Doc$/m);
console.log('✓ old empty placeholders are upgraded to shortcuts');

await fs.rm(scratch, { recursive: true, force: true });
console.log('\nall mirror checks passed');
