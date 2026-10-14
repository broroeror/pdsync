// Offline check of the mirror's safety rules against an in-memory fake Drive.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const scratch = await fs.mkdtemp(path.join(process.env.PDSYNC_TEST_TMP || os.tmpdir(), 'pdsync-test-'));
process.env.XDG_STATE_HOME = path.join(scratch, 'state');
const { Mirror, openState } = await import('../src/mirror.ts');

type FakeNode = { uid: string; parentUid?: string; name: string; type: 'file' | 'folder'; rev?: string; content?: string; trashed?: boolean };

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
            trashTime: n.trashed ? new Date() : undefined,
            modificationTime: new Date('2025-01-02T03:04:05Z'),
            treeEventScopeId: 'vol',
            activeRevision: n.type === 'file' ? { uid: n.rev, claimedModificationTime: new Date('2025-01-02T03:04:05Z') } : undefined,
        };
    }
    client(): any {
        return {
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
                            const writer = stream.getWriter();
                            await writer.write(new TextEncoder().encode(node.content!));
                            if (fail) throw new Error('network went away');
                            await writer.close();
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

await fs.rm(scratch, { recursive: true, force: true });
console.log('\nall mirror checks passed');
