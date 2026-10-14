// Offline check of moving things to a trash folder on another drive, and of
// the desktop-trash mode (with a stand-in `gio`, so the real trash is untouched).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { moveToTrash } from '../src/trash.ts';

const scratch = await fs.mkdtemp(path.join(process.env.PDSYNC_TEST_TMP || os.tmpdir(), 'pdsync-trash-'));
// A trash folder on the home drive: a different filesystem from /tmp, so this
// exercises the copy-verify-remove path used for external drives.
const otherDrive = await fs.mkdtemp(path.join(os.homedir(), '.cache', 'pdsync-trash-test-'));
const src = path.join(scratch, 'mirror');
await fs.mkdir(path.join(src, 'Folder/Sub'), { recursive: true });
await fs.writeFile(path.join(src, 'file.txt'), 'hello');
await fs.writeFile(path.join(src, 'Folder/a.bin'), Buffer.alloc(300_000, 7));
await fs.writeFile(path.join(src, 'Folder/Sub/b.txt'), 'nested');
const old = new Date('2024-05-06T07:08:09Z');
await fs.utimes(path.join(src, 'file.txt'), old, old);

try {
    const target = { kind: 'folder' as const, dir: otherDrive };
    let result = await moveToTrash(path.join(src, 'file.txt'), 'file.txt', target);
    assert.ok(result.ok);
    const [dated] = await fs.readdir(otherDrive);
    const moved = path.join(otherDrive, dated, 'file.txt');
    assert.equal(await fs.readFile(moved, 'utf8'), 'hello');
    assert.equal((await fs.stat(moved)).mtime.toISOString(), old.toISOString(), 'timestamps kept');
    await assert.rejects(fs.stat(path.join(src, 'file.txt')));
    result = await moveToTrash(path.join(src, 'Folder'), 'Folder', target);
    assert.ok(result.ok);
    assert.equal((await fs.stat(path.join(otherDrive, dated, 'Folder/a.bin'))).size, 300_000);
    assert.equal(await fs.readFile(path.join(otherDrive, dated, 'Folder/Sub/b.txt'), 'utf8'), 'nested');
    await assert.rejects(fs.stat(path.join(src, 'Folder')));
    console.log('✓ cross-drive trash: copied, verified, original removed, timestamps kept');

    await fs.writeFile(path.join(src, 'again.txt'), 'x');
    const missing = await moveToTrash(path.join(src, 'again.txt'), 'again.txt', { kind: 'folder', dir: path.join(otherDrive, 'not-mounted') });
    assert.equal(missing.ok, false);
    assert.equal(await fs.readFile(path.join(src, 'again.txt'), 'utf8'), 'x', 'kept when the trash is unavailable');
    await assert.rejects(fs.stat(path.join(otherDrive, 'not-mounted')), 'never creates the trash folder');
    console.log('✓ unavailable trash folder: file kept, folder not created');

    // Desktop mode calls `gio trash -- <path>`; a stand-in records the call.
    const bin = path.join(scratch, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'gio'), `#!/bin/sh\necho "$@" > "${scratch}/gio-called"\n`, { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${bin}:${realPath}`;
    result = await moveToTrash(path.join(src, 'again.txt'), 'again.txt', { kind: 'desktop' });
    process.env.PATH = realPath;
    assert.ok(result.ok);
    assert.equal((await fs.readFile(path.join(scratch, 'gio-called'), 'utf8')).trim(), `trash -- ${path.join(src, 'again.txt')}`);
    console.log('✓ desktop mode hands the file to gio trash');
} finally {
    await fs.rm(otherDrive, { recursive: true, force: true });
    await fs.rm(scratch, { recursive: true, force: true });
}
console.log('\nall trash checks passed');
