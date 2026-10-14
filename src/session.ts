// Saved login: interactive login once, then resume from the keyring.
import { MemoryCache, ProtonDriveClient } from '@protontech/drive-sdk';
import { loadAccount } from './account.ts';
import { Api, ApiError, type Session } from './api.ts';
import { initCrypto, openPGPModule, srpModule } from './crypto.ts';
import { clearSecret, loadSecret, saveSecret } from './keyring.ts';
import { login, type Prompts } from './login.ts';
import { telemetry } from './logging.ts';
import { ask } from './prompt.ts';
import { createInterface } from 'node:readline';

// What the keyring holds. `keyPassword` is derived from the account password
// and unlocks the account keys; the password itself is never stored.
type Stored = { username: string; session: Session; keyPassword: string };

/** An error with a message meant for the user, printed without a stack trace. */
export class UserError extends Error {}

/** The saved login is missing, expired, or was signed out elsewhere. */
export class AuthError extends UserError {}

/** Turns login failures into messages a person can act on. */
function friendlyLoginError(error: unknown): string {
    if (error instanceof ApiError) {
        if (error.code === 8002) return 'Wrong email/username or password. (Accounts made with another email log in with that email.)';
        if (error.code === 9001) return 'Proton wants a human-verification check. Log in once at drive.proton.me in a browser, then try again.';
        if (error.code === 8100 || error.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
        return `Proton refused the login: ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
}

async function completeLogin(api: Api, username: string, password: string, prompts: Prompts) {
    const { session, keyPassword } = await login(api, username, password, prompts);
    // Unlock the keys once now, so a mistake shows up here and not on first sync.
    await loadAccount(api, keyPassword);
    await saveSecret(JSON.stringify({ username, session: api.session ?? session, keyPassword } satisfies Stored));
}

/**
 * Login driven by another program (the desktop app) over stdin/stdout, one
 * JSON object per line, so the password never appears in a command line.
 *   in:  {"username": "...", "password": "..."}   then {"value": "..."} per request
 *   out: {"event": "need", "what": "totp" | "mailboxPassword"}
 *        {"event": "ok", "username": "..."} | {"event": "error", "message": "..."}
 */
export async function machineLogin() {
    initCrypto();
    const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
    const next = async () => {
        const { value, done } = await lines.next();
        if (done) throw new Error('Login cancelled');
        return JSON.parse(value);
    };
    const emit = (message: object) => process.stdout.write(JSON.stringify(message) + '\n');
    const need = async (what: string) => {
        emit({ event: 'need', what });
        return String((await next()).value ?? '');
    };

    try {
        const { username, password } = await next();
        await completeLogin(new Api(), username, password, {
            totp: () => need('totp'),
            mailboxPassword: () => need('mailboxPassword'),
        });
        emit({ event: 'ok', username });
    } catch (error) {
        emit({ event: 'error', message: friendlyLoginError(error) });
        process.exitCode = 1;
    } finally {
        process.stdin.destroy();
    }
}

export async function interactiveLogin() {
    initCrypto();
    console.log('This is a third-party application not officially supported by Proton.\n');
    const api = new Api();
    const username = await ask('Username (for accounts made with another email, use that email): ');
    const password = await ask('Password: ', { hidden: true });
    try {
        await completeLogin(api, username, password, {
            totp: () => ask('2FA code: '),
            mailboxPassword: () => ask('Mailbox password: ', { hidden: true }),
        });
    } catch (error) {
        throw new UserError(friendlyLoginError(error));
    }
    console.log(`Logged in as ${username}. The login is saved in your desktop keyring.`);
}

/** `clientUid` identifies this installation, so the SDK can clean up its own interrupted uploads. */
export async function openClient(clientUid?: string) {
    initCrypto();
    const raw = await loadSecret();
    if (!raw) throw new AuthError('Not logged in.');
    const stored: Stored = JSON.parse(raw);

    const api = new Api();
    api.session = stored.session;
    api.onSessionChange = (session) => saveSecret(JSON.stringify({ ...stored, session } satisfies Stored));

    let account;
    try {
        account = await loadAccount(api, stored.keyPassword);
    } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
            throw new AuthError('The saved login has expired or was signed out. Please log in again.');
        }
        throw error;
    }

    const client = new ProtonDriveClient({
        httpClient: api.httpClient(),
        entitiesCache: new MemoryCache(),
        cryptoCache: new MemoryCache(),
        account,
        openPGPCryptoModule: openPGPModule(),
        srpModule: srpModule(api),
        telemetry,
        config: { clientUid },
    });
    return { api, client, username: stored.username };
}

/** Who is logged in, without contacting Proton (null = nobody). */
export async function savedUsername(): Promise<string | null> {
    const raw = await loadSecret();
    return raw ? (JSON.parse(raw) as Stored).username : null;
}

export async function logout() {
    const raw = await loadSecret();
    if (raw) {
        // End the session on Proton's side too; clear locally even if that fails.
        const api = new Api();
        api.session = (JSON.parse(raw) as Stored).session;
        await api.request('DELETE', 'core/v4/auth').catch(() => {});
    }
    await clearSecret();
    console.log('Logged out. The saved login was removed from your keyring.');
}
