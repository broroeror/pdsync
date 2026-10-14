// Stores the saved login in the desktop's Secret Service keyring (GNOME
// Keyring or KDE Wallet, whichever provides it) via libsecret's secret-tool.
import { spawn } from 'node:child_process';

const ATTRIBUTES = ['service', 'pdsync', 'kind', 'session'];

function secretTool(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn('secret-tool', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', (error: NodeJS.ErrnoException) =>
            reject(error.code === 'ENOENT' ? new Error('secret-tool not found: install libsecret') : error),
        );
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
        child.stdin.end(input ?? '');
    });
}

export async function saveSecret(value: string) {
    const { code, stderr } = await secretTool(['store', '--label=pdsync saved login', ...ATTRIBUTES], value);
    if (code !== 0) throw new Error(`Could not save to the keyring: ${stderr.trim()}`);
}

/** Returns null when nothing is stored. */
export async function loadSecret(): Promise<string | null> {
    const { code, stdout } = await secretTool(['lookup', ...ATTRIBUTES]);
    return code === 0 && stdout ? stdout : null;
}

export async function clearSecret() {
    await secretTool(['clear', ...ATTRIBUTES]);
}
