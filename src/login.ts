// SRP login against the core API, then derivation of the key password that
// unlocks the account's private keys.
import { getSrp, computeKeyPassword } from '@protontech/crypto/srp';
import { ApiError, type Api, type Session } from './api.ts';

// Bitmask in the auth response's `2FA.Enabled`.
const TWO_FA_TOTP = 1;
const TWO_FA_FIDO = 2;
// Proton allows a few code attempts per login before the session must restart.
const MAX_TOTP_ATTEMPTS = 3;
// `PasswordMode` 2 = the account has a separate mailbox password for its keys.
const TWO_PASSWORD_MODE = 2;

/** Proton wants a person to complete a check (code 9001) before this login. */
export type HumanCheck = { url: string; methods: string[]; token: string };

export type Prompts = {
    /**
     * Show the check (open `url`) and resolve once the person says they've
     * completed it; reject to cancel the login.
     */
    humanVerification?: (check: HumanCheck, attempt: number) => Promise<void>;
    /** Ask for a 2FA code; `retryReason` is set when the previous code was refused. */
    totp: (retryReason?: string) => Promise<string>;
    mailboxPassword: () => Promise<string>;
};

export type LoginResult = { session: Session; keyPassword: string };

const HUMAN_VERIFICATION = 9001;
const MAX_HUMAN_CHECKS = 3;

/** The check page from Proton's answer, used only if it really is verify.proton.me. */
export function checkUrl(webUrl: unknown, token: string, methods: string[]) {
    try {
        const url = new URL(String(webUrl));
        if (url.protocol === 'https:' && url.hostname === 'verify.proton.me') return url.toString();
    } catch {
        // Missing or malformed: build the standard one below.
    }
    return `https://verify.proton.me/?methods=${encodeURIComponent(methods.join(','))}&token=${encodeURIComponent(token)}`;
}

/**
 * Run `attempt`; if Proton answers "human verification needed", let the
 * person complete the check, then run it again presenting the same token
 * (which Proton accepts once the check is done). The whole exchange is
 * retried, since a password proof can't be reused.
 */
export async function withHumanVerification<T>(prompts: Prompts, attempt: (headers?: Record<string, string>) => Promise<T>) {
    let headers: Record<string, string> | undefined;
    for (let round = 1; ; round++) {
        try {
            return await attempt(headers);
        } catch (error) {
            if (!(error instanceof ApiError) || error.code !== HUMAN_VERIFICATION || !prompts.humanVerification) throw error;
            const details = (error.body as { Details?: Record<string, unknown> })?.Details ?? {};
            const token = typeof details.HumanVerificationToken === 'string' ? details.HumanVerificationToken : '';
            const methods = Array.isArray(details.HumanVerificationMethods) ? details.HumanVerificationMethods.map(String) : [];
            if (!token || round > MAX_HUMAN_CHECKS) throw error;
            await prompts.humanVerification({ url: checkUrl(details.WebUrl, token, methods), methods, token }, round);
            headers = {
                'x-pm-human-verification-token': token,
                'x-pm-human-verification-token-type': methods.join(','),
            };
        }
    }
}

export async function login(api: Api, username: string, password: string, prompts: Prompts): Promise<LoginResult> {
    const { srp, auth } = await withHumanVerification(prompts, async (headers) => {
        const info = await api.request('POST', 'core/v4/auth/info', { Username: username, Intent: 'Proton' }, headers);
        if (process.env.DEBUG_LOGIN) {
            // Never print the password itself; its length is enough to spot a mangled prompt.
            console.log(`[debug] username=${JSON.stringify(username)} passwordLength=${password.length} authVersion=${info.Version}`);
        }
        const srp = await getSrp(info, { username, password });
        const auth = await api.request(
            'POST',
            'core/v4/auth',
            { Username: username, ClientEphemeral: srp.clientEphemeral, ClientProof: srp.clientProof, SRPSession: info.SRPSession },
            headers,
        );
        return { srp, auth };
    });

    // The server proves it also knows the password verifier. If this doesn't
    // match, we are not talking to Proton: bail before using the session.
    if (auth.ServerProof !== srp.expectedServerProof) {
        throw new Error('Server proof mismatch: refusing to continue');
    }
    api.session = { uid: auth.UID, accessToken: auth.AccessToken, refreshToken: auth.RefreshToken };

    const twoFA = auth['2FA']?.Enabled ?? 0;
    if (twoFA & TWO_FA_TOTP) {
        // A wrong or expired code can be retried within the same login, so the
        // password isn't asked again. Drive answers a bad code like a bad
        // password (code 8002), which would be misleading to pass on.
        let retryReason: string | undefined;
        for (let attempt = 1; ; attempt++) {
            const code = (await prompts.totp(retryReason)).replace(/\s+/g, '');
            try {
                await api.request('POST', 'core/v4/auth/2fa', { TwoFactorCode: code });
                break;
            } catch (error) {
                const refused = error instanceof ApiError && (error.code === 8002 || error.status === 422);
                if (!refused) throw error;
                if (attempt >= MAX_TOTP_ATTEMPTS) {
                    throw new Error("The 2FA code wasn't accepted. Please start the login again.");
                }
                retryReason = "That code wasn't accepted. Codes change every 30 seconds; enter the current one.";
            }
        }
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
