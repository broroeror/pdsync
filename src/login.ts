// SRP login against the core API, then derivation of the key password that
// unlocks the account's private keys.
import { getSrp, computeKeyPassword } from '@protontech/crypto/srp';
import type { Api, Session } from './api.ts';

// Bitmask in the auth response's `2FA.Enabled`.
const TWO_FA_TOTP = 1;
const TWO_FA_FIDO = 2;
// `PasswordMode` 2 = the account has a separate mailbox password for its keys.
const TWO_PASSWORD_MODE = 2;

export type Prompts = {
    totp: () => Promise<string>;
    mailboxPassword: () => Promise<string>;
};

export type LoginResult = { session: Session; keyPassword: string };

export async function login(api: Api, username: string, password: string, prompts: Prompts): Promise<LoginResult> {
    const info = await api.request('POST', 'core/v4/auth/info', { Username: username, Intent: 'Proton' });
    if (process.env.DEBUG_LOGIN) {
        // Never print the password itself; its length is enough to spot a mangled prompt.
        console.log(`[debug] username=${JSON.stringify(username)} passwordLength=${password.length} authVersion=${info.Version}`);
    }
    const srp = await getSrp(info, { username, password });

    const auth = await api.request('POST', 'core/v4/auth', {
        Username: username,
        ClientEphemeral: srp.clientEphemeral,
        ClientProof: srp.clientProof,
        SRPSession: info.SRPSession,
    });

    // The server proves it also knows the password verifier. If this doesn't
    // match, we are not talking to Proton: bail before using the session.
    if (auth.ServerProof !== srp.expectedServerProof) {
        throw new Error('Server proof mismatch: refusing to continue');
    }
    api.session = { uid: auth.UID, accessToken: auth.AccessToken, refreshToken: auth.RefreshToken };

    const twoFA = auth['2FA']?.Enabled ?? 0;
    if (twoFA & TWO_FA_TOTP) {
        await api.request('POST', 'core/v4/auth/2fa', { TwoFactorCode: await prompts.totp() });
    } else if (twoFA & TWO_FA_FIDO) {
        throw new Error('This account only has a security key (FIDO) as 2FA, which is not supported yet');
    }

    const keysPassword = auth.PasswordMode === TWO_PASSWORD_MODE ? await prompts.mailboxPassword() : password;

    // Salts are only readable shortly after login, so derive the key password now.
    const [{ KeySalts }, { User }] = await Promise.all([
        api.request('GET', 'core/v4/keys/salts'),
        api.request('GET', 'core/v4/users'),
    ]);
    const primaryKey = User.Keys.find((k: any) => k.Primary === 1) ?? User.Keys[0];
    const salt = KeySalts.find((s: any) => s.ID === primaryKey.ID)?.KeySalt;
    if (!salt) throw new Error('No key salt found for the primary user key');

    return { session: api.session, keyPassword: await computeKeyPassword(keysPassword, salt) };
}
