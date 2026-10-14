// One mirror run at a time: a PID lock file next to the state database.
// A lock left behind by a crashed run is detected (its PID is gone) and taken over.
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './session.ts';

function isAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: the process exists but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export function acquireLock(stateDir: string) {
    const file = path.join(stateDir, 'mirror.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
            const release = () => fs.rmSync(file, { force: true });
            process.once('exit', release);
            return release;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const pid = Number(fs.readFileSync(file, 'utf8'));
            if (pid && isAlive(pid)) {
                throw new UserError(`Another mirror run is in progress (process ${pid}); try again when it finishes.`);
            }
            fs.rmSync(file, { force: true });
        }
    }
    throw new UserError('Could not take the mirror lock.');
}

/** PID of the run currently holding the lock, or null. */
export function lockHolder(stateDir: string): number | null {
    try {
        const pid = Number(fs.readFileSync(path.join(stateDir, 'mirror.lock'), 'utf8'));
        return pid && isAlive(pid) ? pid : null;
    } catch {
        return null;
    }
}
