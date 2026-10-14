// Offline check: one mirror run at a time; stale locks are taken over.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock } from '../src/lock.ts';

const dir = fs.mkdtempSync(path.join(process.env.PDSYNC_TEST_TMP || os.tmpdir(), 'pdsync-lock-'));
const release = acquireLock(dir);
assert.throws(() => acquireLock(dir), /Another mirror run is in progress/);
release();
console.log('✓ second run refused while the first holds the lock');

// A lock from a process that no longer exists (PID far above pid_max).
fs.writeFileSync(path.join(dir, 'mirror.lock'), '999999999');
acquireLock(dir)();
console.log('✓ stale lock from a crashed run taken over');
fs.rmSync(dir, { recursive: true, force: true });
