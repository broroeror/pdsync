// Saved login: interactive login once, then resume from the keyring.
import { MemoryCache, ProtonDriveClient } from '@protontech/drive-sdk';
import { loadAccount } from './account.ts';
import { Api, ApiError, type Session } from './api.ts';
import { initCrypto, openPGPModule, srpModule } from './crypto.ts';
import { clearSecret, loadSecret, saveSecret } from './keyring.ts';
import { login } from './login.ts';
import { telemetry } from './logging.ts';
import { ask } from './prompt.ts';

// What the keyring holds. `keyPassword` is derived from the account password
// and unlocks the account keys; the password itself is never stored.
type Stored = { username: string; session: Session; keyPassword: string };

/** An error with a message meant for the user, printed without a stack trace. */
export class UserError extends Error {}

export async function interactiveLogin() {
    initCrypto();
    console.log('This is a third-party application not officially supported by Proton.\n');
    const api = new Api();
    const username = await ask('Username (for accounts made with another email, use that email): ');
    const password = await ask('Password: ', { hidden: true });
    const { session, keyPassword } = await login(api, username, password, {
        totp: () => ask('2FA code: '),
        mailboxPassword: () => ask('Mailbox password: ', { hidden: true }),
    });
    // Unlock the keys once now, so a mistake shows up here and not on first sync.
    await loadAccount(api, keyPassword);
    await saveSecret(JSON.stringify({ username, session: api.session ?? session, keyPassword } satisfies Stored));
    console.log(`Logged in as ${username}. The login is saved in your desktop keyring.`);
}

export async function openClient() {
    initCrypto();
    const raw = await loadSecret();
    if (!raw) throw new UserError('Not logged in. Run: npm run pdsync login');
    const stored: Stored = JSON.parse(raw);

    const api = new Api();
    api.session = stored.session;
    api.onSessionChange = (session) => saveSecret(JSON.stringify({ ...stored, session } satisfies Stored));

    let account;
    try {
        account = await loadAccount(api, stored.keyPassword);
    } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
            throw new UserError('The saved login has expired or was signed out. Run: npm run pdsync login');
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
    });
    return { api, client, username: stored.username };
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
