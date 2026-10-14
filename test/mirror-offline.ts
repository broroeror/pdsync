// Offline check of the mirror's safety rules against an in-memory fake Drive.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const scratch = await fs.mkdtemp(path.join(process.env.PDSYNC_TEST_TMP || os.tmpdir(), 'pdsync-test-'));
process.env.XDG_STATE_HOME = path.join(scratch, 'state');
const { Mirror, openState } = await import('../src/mirror.ts');
const { NodeWithSameNameExistsValidationError } = await import('@protontech/drive-sdk');

type FakeNode = { uid: string; parentUid?: string; name: string; type: 'file' | 'folder'; rev?: string; content?: string; trashed?: boolean; mediaType?: string };

class FakeDrive {
    nodes = new Map<string, FakeNode>();
    events: any[] = [];
    failDownloads = false;
    trashCalls: string[] = [];
    seq = 0;

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
    assertFreeName(parentUid: string, name: string) {
        for (const n of this.nodes.values()) {
            if (n.parentUid === parentUid && n.name === name && !n.trashed) {
                throw new NodeWithSameNameExistsValidationError('exists', 2500, n.uid);
            }
        }
    }
    childNamed(parentUid: string, name: string) {
        return [...this.nodes.values()].find((n) => n.parentUid === parentUid && n.name === name && !n.trashed);
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
            createFolder: async (parentUid: string, name: string) => {
                this.assertFreeName(parentUid, name);
                const uid = `new${++this.seq}`;
                this.add({ uid, parentUid, name, type: 'folder' });
                return this.entity(this.nodes.get(uid)!);
            },
            moveNodes: async function* (this: FakeDrive, uids: string[], newParent: string) {
                for (const uid of uids) {
                    const n = this.nodes.get(uid)!;
                    try {
                        this.assertFreeName(newParent, n.name);
                    } catch (error) {
                        yield { uid, ok: false, error };
                        continue;
                    }
                    n.parentUid = newParent;
                    this.emit('node_updated', uid);
                    yield { uid, ok: true };
                }
            }.bind(this),
            trashNodes: async function* (this: FakeDrive, uids: string[]) {
                for (const uid of uids) {
                    this.trashCalls.push(uid);
                    this.nodes.get(uid)!.trashed = true;
                    this.emit('node_updated', uid);
                    yield { uid, ok: true };
                }
            }.bind(this),
            renameNode: async (uid: string, name: string) => {
                const n = this.nodes.get(uid)!;
                this.assertFreeName(n.parentUid!, name);
                n.name = name;
                this.emit('node_updated', uid);
                return this.entity(n);
            },
            getFileRevisionUploader: async (uid: string) => ({
                uploadFromStream: async (stream: ReadableStream<Uint8Array>) => ({
                    completion: async () => {
                        const n = this.nodes.get(uid)!;
                        n.content = await new Response(stream).text();
                        n.rev = `${uid}-v${++this.seq}`;
                        this.emit('node_updated', uid);
                        return { nodeUid: uid, nodeRevisionUid: n.rev };
                    },
                }),
            }),
            getFileUploader: async (parentUid: string, name: string) => ({
                uploadFromStream: async (stream: ReadableStream<Uint8Array>) => ({
                    completion: async () => {
                        this.assertFreeName(parentUid, name);
                        const content = await new Response(stream).text();
                        const uid = `new${++this.seq}`;
                        this.add({ uid, parentUid, name, type: 'file', rev: `${uid}-r1`, content });
                        return { nodeUid: uid, nodeRevisionUid: `${uid}-r1` };
                    },
                }),
            }),
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
// A scratch trash folder: tests must never touch the real desktop trash.
const trashDir = path.join(scratch, 'trash');
await fs.mkdir(trashDir);
db.prepare("INSERT INTO meta (key, value) VALUES ('trash', ?)").run(trashDir);
/** Paths (relative to the trash folder's dated subfolder) of everything in the trash. */
async function trashed(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string) => {
        for (const d of await fs.readdir(dir, { withFileTypes: true })) {
            const r = rel ? `${rel}/${d.name}` : d.name;
            if (d.isDirectory()) await walk(path.join(dir, d.name), r);
            else out.push(r.split('/').slice(1).join('/'));
        }
    };
    await walk(trashDir, '');
    return out.sort();
}
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

// 7. Trashed on Drive: the local copy goes to the trash (never deleted).
drive.update('a', { trashed: true });
m = await run();
assert.equal(await exists('Documents/renamed.txt'), false);
assert.ok((await trashed()).includes('Documents/renamed.txt'));
console.log('✓ a file deleted on Drive moves to the trash');

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

// 14. Deletions on Drive vs. the trash, and what the planner makes of them.
const { planUploads } = await import('../src/plan.ts');
const leftovers = () => (db.prepare('SELECT rel_path, reason FROM leftovers ORDER BY rel_path').all() as any[]).map((r) => `${r.rel_path}:${r.reason}`);
let plan;

// Trash unreachable (drive unplugged): keep the copy, don't re-upload it, retry later.
drive.add({ uid: 'h', parentUid: 'root', name: 'drive-deletes-me.txt', type: 'file', rev: 'h1', content: 'H' });
await run();
await fs.rename(trashDir, trashDir + '-unplugged');
drive.update('h', { trashed: true });
await run();
assert.equal(await read('drive-deletes-me.txt'), 'H');
assert.ok(leftovers().includes('drive-deletes-me.txt:removed-on-drive'));
plan = await planUploads(db, root);
assert.ok(!plan.items.some((i) => i.action === 'upload' && i.rel === 'drive-deletes-me.txt'), 'must not re-upload a Drive deletion');
assert.equal(await fs.stat(trashDir).then(() => true, () => false), false, 'never creates the trash folder itself');
await fs.rename(trashDir + '-unplugged', trashDir);
await run();
assert.equal(await exists('drive-deletes-me.txt'), false);
assert.ok((await trashed()).includes('drive-deletes-me.txt'));
assert.ok(!leftovers().includes('drive-deletes-me.txt:removed-on-drive'));
console.log('✓ unreachable trash: copy kept, not re-uploaded, trashed once it is back');

// Edited here, deleted on Drive: the edit wins (kept, and planned for upload).
drive.add({ uid: 'w', parentUid: 'root', name: 'my-work.txt', type: 'file', rev: 'w1', content: 'W' });
await run();
await fs.writeFile(path.join(root, 'my-work.txt'), 'W plus an hour of my work');
drive.update('w', { trashed: true });
await run();
assert.equal(await read('my-work.txt'), 'W plus an hour of my work');
plan = await planUploads(db, root);
assert.ok(plan.items.some((i) => i.action === 'upload' && i.rel === 'my-work.txt'));
console.log('✓ a copy edited here is kept when Drive deletes it (your edit wins)');

// Deletions with nothing to move still say what happened.
drive.add({ uid: 'q1', parentUid: 'root', name: 'already-gone.png', type: 'file', rev: 'q1', content: 'Q' });
drive.add({ uid: 'q2', parentUid: 'root', name: 'renamed-here.png', type: 'file', rev: 'q2', content: 'R' });
await run();
await fs.rm(path.join(root, 'already-gone.png'));
await fs.rename(path.join(root, 'renamed-here.png'), path.join(root, 'my name for it.png'));
drive.update('q1', { trashed: true });
drive.update('q2', { trashed: true });
m = await run();
const said = (rel: string) => (db.prepare("SELECT detail FROM activity WHERE kind = 'removed' AND path = ? ORDER BY id DESC").get(rel) as any)?.detail;
assert.match(said('already-gone.png'), /already gone/);
assert.match(said('renamed-here.png'), /renamed your copy here to "my name for it.png"/);
assert.equal(await read('my name for it.png'), 'R');
console.log('✓ every Drive deletion is reported, even when there was nothing to move');

// A deleted folder goes to the trash whole when it only holds synced files...
drive.add({ uid: 'F', parentUid: 'root', name: 'Shared Stuff', type: 'folder' });
drive.add({ uid: 'F1', parentUid: 'F', name: 'one.txt', type: 'file', rev: 'f1', content: '1' });
drive.add({ uid: 'F2', parentUid: 'F', name: 'two.txt', type: 'file', rev: 'f2', content: '2' });
await run();
drive.update('F', { trashed: true });
await run();
assert.equal(await exists('Shared Stuff'), false);
assert.ok((await trashed()).includes('Shared Stuff/one.txt') && (await trashed()).includes('Shared Stuff/two.txt'));
// ...but a folder holding your own files keeps them (only synced files go).
drive.add({ uid: 'G', parentUid: 'root', name: 'Mixed', type: 'folder' });
drive.add({ uid: 'G1', parentUid: 'G', name: 'synced.txt', type: 'file', rev: 'g1', content: 'S' });
await run();
await fs.writeFile(path.join(root, 'Mixed/mine-only.txt'), 'never on Drive');
drive.update('G', { trashed: true });
await run();
assert.equal(await read('Mixed/mine-only.txt'), 'never on Drive');
assert.equal(await exists('Mixed/synced.txt'), false);
assert.ok((await trashed()).includes('Mixed/synced.txt'));
console.log('✓ deleted folders: trashed whole, or only their synced files if you added your own');

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

// 17. Uploading new files and folders (stage 1).
const NEW = new Set(['new'] as const);
await fs.mkdir(path.join(root, 'Uploads/Sub'), { recursive: true });
await fs.writeFile(path.join(root, 'Uploads/Sub/deep.txt'), 'deep content');
await fs.writeFile(path.join(root, 'top-new.txt'), 'top content');
m = new Mirror(drive.client(), db, root);
await m.run();
await m.applyPlan(await planUploads(db, root), NEW);
const uploadsFolder = drive.childNamed('root', 'Uploads')!;
const sub = drive.childNamed(uploadsFolder.uid, 'Sub')!;
assert.equal(drive.childNamed(sub.uid, 'deep.txt')?.content, 'deep content');
assert.equal(drive.childNamed('root', 'top-new.txt')?.content, 'top content');
assert.ok(m.uploaded >= 2, 'also uploads local-only files left by earlier tests');
m = await run();
assert.equal(m.downloaded, 0, 'own uploads are not downloaded back');
plan = await planUploads(db, root);
assert.ok(!plan.items.some((i) => 'rel' in i && (i.rel.startsWith('Uploads') || i.rel === 'top-new.txt')), 'nothing left to upload');
console.log('✓ new folders and files upload into the right place, once');

// Only the kinds switched on are carried out.
await fs.appendFile(path.join(root, 'top-new.txt'), ' edited');
await fs.writeFile(path.join(root, 'another-new.txt'), 'A');
const before = drive.childNamed('root', 'top-new.txt')!.rev;
m = new Mirror(drive.client(), db, root);
await m.applyPlan(await planUploads(db, root), NEW);
assert.equal(drive.childNamed('root', 'top-new.txt')!.rev, before, 'edits stay off');
assert.ok(drive.childNamed('root', 'another-new.txt'));
console.log('✓ only switched-on kinds are uploaded (edits untouched)');

// A name already taken on Drive fails politely; the other uploads go ahead.
drive.nodes.set('ghost', { uid: 'ghost', parentUid: 'root', name: 'taken.txt', type: 'file', rev: 'g1', content: 'on Drive' });
await fs.writeFile(path.join(root, 'taken.txt'), 'mine');
await fs.writeFile(path.join(root, 'fine.txt'), 'fine');
m = new Mirror(drive.client(), db, root);
await m.applyPlan(await planUploads(db, root), NEW);
assert.equal(m.failures, 1);
assert.match((db.prepare("SELECT detail FROM activity WHERE kind = 'failed' ORDER BY id DESC").get() as any).detail, /already has an item with this name/);
assert.equal(drive.childNamed('root', 'taken.txt')!.content, 'on Drive', 'never overwritten');
assert.ok(drive.childNamed('root', 'fine.txt'));
await fs.rm(path.join(root, 'taken.txt')); // don't leave a clash for later tests
console.log('✓ a name clash on Drive fails politely, others still upload');

// A blocked plan (folder missing / empty) uploads nothing.
const countBefore = drive.nodes.size;
await new Mirror(drive.client(), db, root).applyPlan({ items: [{ action: 'upload', rel: 'fine.txt', size: 4 }], held: [], blocked: 'unmounted' }, NEW);
assert.equal(drive.nodes.size, countBefore);
console.log('✓ a blocked plan uploads nothing');

// 18. Moves and renames (stage 3), and things that depend on them.
const { planForKinds } = await import('../src/plan.ts');
const NEW_AND_MOVES = new Set(['new', 'moves'] as const);
const push = async (kinds: Set<any> = NEW_AND_MOVES) => {
    const mm = new Mirror(drive.client(), db, root);
    await mm.run();
    await mm.applyPlan(planForKinds(db, await planUploads(db, root), kinds), kinds);
    return mm;
};
const pathOnDrive = (uid: string) => {
    const parts: string[] = [];
    for (let n = drive.nodes.get(uid); n && n.uid !== 'root'; n = drive.nodes.get(n.parentUid!)) parts.unshift(n.name);
    return parts.join('/');
};

// The user's real case, in one go.
drive.add({ uid: 'TF', parentUid: 'root', name: 'Test Folder', type: 'folder' });
drive.add({ uid: 'TF1', parentUid: 'TF', name: 'song.mp3', type: 'file', rev: 's1', content: 'tune' });
drive.add({ uid: 'TFD', parentUid: 'TF', name: 'Notes', type: 'file', rev: 'nd', content: '', mediaType: DOC });
await run();
await fs.mkdir(path.join(root, 'New Folder 2'));
await fs.rename(path.join(root, 'Test Folder'), path.join(root, 'New Folder 2/Test Folder'));
await fs.writeFile(path.join(root, 'New Folder 2/Test Folder/fresh.docx'), 'D');
m = await push();
assert.equal(m.failures, 0);
assert.equal(pathOnDrive('TF'), 'New Folder 2/Test Folder');
assert.equal(pathOnDrive('TF1'), 'New Folder 2/Test Folder/song.mp3', 'contents moved with the folder');
assert.equal(drive.childNamed('TF', 'fresh.docx')?.content, 'D', 'uploaded into the moved folder');
assert.ok(![...drive.nodes.values()].some((n) => n.name.endsWith('.desktop')), 'the shortcut never reached Drive');
m = await run();
assert.equal(m.downloaded, 0, 'nothing comes back down');
assert.equal(await exists('Test Folder'), false, 'the old folder is not recreated');
plan = await planUploads(db, root);
assert.ok(!plan.items.some((i) => i.action === 'move' || ('rel' in i && i.rel.includes('Test Folder'))), 'in sync afterwards');
console.log('✓ the real case: create, move a folder into it, upload into the moved folder');

// A plain rename, and a file moved into another folder.
await fs.rename(path.join(root, 'New Folder 2/Test Folder/song.mp3'), path.join(root, 'New Folder 2/Test Folder/song renamed.mp3'));
await fs.rename(path.join(root, 'fine.txt'), path.join(root, 'New Folder 2/fine.txt'));
m = await push();
assert.equal(pathOnDrive('TF1'), 'New Folder 2/Test Folder/song renamed.mp3');
assert.equal(drive.childNamed(drive.childNamed('root', 'New Folder 2')!.uid, 'fine.txt')?.content, 'fine');
m = await run();
assert.equal(m.downloaded, 0);
console.log('✓ renames and moves of files carry over to Drive');

// Moves stay off unless switched on: then the file just waits.
await fs.rename(path.join(root, 'New Folder 2/fine.txt'), path.join(root, 'fine-again.txt'));
await push(new Set(['new']));
assert.ok(drive.childNamed(drive.childNamed('root', 'New Folder 2')!.uid, 'fine.txt'), 'not moved while moves are off');
await push();
assert.ok(drive.childNamed('root', 'fine-again.txt'));
console.log('✓ moves only happen when switched on');

// A move whose new name is taken on Drive fails politely; nothing local changes.
drive.nodes.set('ghost2', { uid: 'ghost2', parentUid: 'root', name: 'occupied.txt', type: 'file', rev: 'x', content: 'Drive' });
await fs.rename(path.join(root, 'fine-again.txt'), path.join(root, 'occupied.txt'));
m = await push();
assert.equal(m.failures, 1);
assert.equal(await read('occupied.txt'), 'fine');
assert.equal(drive.nodes.get('ghost2')!.content, 'Drive');
await fs.rename(path.join(root, 'occupied.txt'), path.join(root, 'fine-again.txt')); // don't leave a clash for later tests
console.log('✓ a move into a taken name fails politely');

// 19. Edits (stage 2): a new version goes up; Drive changes meanwhile → Review.
const ALL = new Set(['new', 'edits', 'moves'] as const);
const songUid = 'TF1';
await fs.writeFile(path.join(root, 'New Folder 2/Test Folder/song renamed.mp3'), 'tune, remastered');
const revBefore = drive.nodes.get(songUid)!.rev;
m = await push(ALL);
assert.equal(drive.nodes.get(songUid)!.content, 'tune, remastered');
assert.notEqual(drive.nodes.get(songUid)!.rev, revBefore, 'a new version, not a new file');
m = await run();
assert.equal(m.downloaded, 0, 'own new version is not downloaded back');
assert.ok(!(await planUploads(db, root)).items.some((i) => i.action === 'update'), 'no edit left pending');
console.log('✓ an edit uploads as a new version of the same file');

// Race: Drive changes the file after planning, before uploading.
await fs.writeFile(path.join(root, 'New Folder 2/Test Folder/song renamed.mp3'), 'my local take');
const racePlan = planForKinds(db, await planUploads(db, root), ALL);
drive.nodes.get(songUid)!.content = 'someone else on Drive';
drive.nodes.get(songUid)!.rev = 'race-rev';
m = new Mirror(drive.client(), db, root);
await m.applyPlan(racePlan, ALL);
assert.equal(drive.nodes.get(songUid)!.content, 'someone else on Drive', 'never uploaded over a newer Drive version');
assert.ok(reviewRows().some((r) => r.uid === songUid && r.reason === 'local-edit'));
assert.equal(await read('New Folder 2/Test Folder/song renamed.mp3'), 'my local take');
console.log('✓ Drive changed meanwhile: sent to Review, nothing overwritten');

// With edits on, "Keep mine" uploads yours as the next version.
await new Mirror(drive.client(), db, root).resolve(songUid, 'keep-local', { uploadsEdits: true });
m = await push(ALL);
assert.equal(drive.nodes.get(songUid)!.content, 'my local take');
assert.ok(!reviewRows().some((r) => r.uid === songUid));
console.log('✓ Keep mine (with edits on) uploads your version as the new one');

// 20. Deletions (stage 4): local deletes go to Drive's trash.
const WITH_DELETES = new Set(['new', 'edits', 'moves', 'deletes'] as const);
drive.add({ uid: 'X1', parentUid: 'root', name: 'delete-me.txt', type: 'file', rev: 'x1', content: 'X' });
drive.add({ uid: 'XF', parentUid: 'root', name: 'Old Stuff', type: 'folder' });
drive.add({ uid: 'XF1', parentUid: 'XF', name: 'a.txt', type: 'file', rev: 'xa', content: 'a' });
drive.add({ uid: 'XF2', parentUid: 'XF', name: 'b.txt', type: 'file', rev: 'xb', content: 'b' });
await run();
await fs.rm(path.join(root, 'delete-me.txt'));
await fs.rm(path.join(root, 'Old Stuff'), { recursive: true });
await push(new Set(['new', 'edits', 'moves']));
assert.equal(drive.nodes.get('X1')!.trashed, undefined, 'deletes stay off unless switched on');
drive.trashCalls = [];
m = await push(WITH_DELETES);
assert.ok(drive.nodes.get('X1')!.trashed && drive.nodes.get('XF')!.trashed);
assert.ok(drive.trashCalls.includes('X1') && drive.trashCalls.includes('XF'));
assert.ok(!drive.trashCalls.includes('XF1') && !drive.trashCalls.includes('XF2'), 'a deleted folder is one trash action, not one per file');
m = await run();
assert.equal(m.downloaded, 0, 'nothing comes back');
assert.equal(await exists('delete-me.txt'), false);
console.log("✓ local deletions go to Drive's trash (a folder as one action)");

// Many deletions at once are held; "download them again" restores them...
drive.add({ uid: 'BULK', parentUid: 'root', name: 'Bulk', type: 'folder' });
for (let i = 0; i < 14; i++) drive.add({ uid: `B${i}`, parentUid: 'BULK', name: `photo${i}.jpg`, type: 'file', rev: `b${i}`, content: `p${i}` });
await run();
await fs.rm(path.join(root, 'Bulk'), { recursive: true });
drive.trashCalls = [];
m = await push(WITH_DELETES);
assert.deepEqual(drive.trashCalls, [], 'mass deletion held');
const held = await planUploads(db, root);
assert.equal(held.massDelete?.files, 14);
m = new Mirror(drive.client(), db, root);
m.restoreMissing(held.massDelete!.items);
await m.run();
assert.equal(await read('Bulk/photo3.jpg'), 'p3');
console.log('✓ a mass deletion is held, and can be undone (files downloaded again)');

// ...or confirmed, which trashes them on Drive.
await fs.rm(path.join(root, 'Bulk'), { recursive: true });
m = new Mirror(drive.client(), db, root);
await m.run();
await m.applyPlan(planForKinds(db, await planUploads(db, root, { allowMassDelete: true }), WITH_DELETES), WITH_DELETES);
assert.ok(drive.nodes.get('BULK')!.trashed);
console.log("✓ a confirmed mass deletion goes to Drive's trash");

await fs.rm(scratch, { recursive: true, force: true });
console.log('\nall mirror checks passed');
