// The SDK's view of the account: own addresses with unlocked private keys,
// plus public-key lookup used to verify signatures (own and other users').
import { CryptoProxy, VERIFICATION_STATUS } from '@protontech/crypto';
import type { ProtonDriveAccount, ProtonDriveAccountAddress } from '@protontech/drive-sdk';
import type { Api } from './api.ts';

// Address `Status` 1 = enabled.
const ADDRESS_ENABLED = 1;

type PublicKey = Awaited<ReturnType<typeof CryptoProxy.importPublicKey>>;

async function unlockUserKeys(api: Api, keyPassword: string) {
    const { User } = await api.request('GET', 'core/v4/users');
    const keys = [];
    for (const k of User.Keys) {
        if (k.Active !== 1) continue;
        keys.push(await CryptoProxy.importPrivateKey({ armoredKey: k.PrivateKey, passphrase: keyPassword }));
    }
    if (!keys.length) throw new Error('Could not unlock any user key: wrong password?');
    return keys;
}

async function unlockAddresses(api: Api, keyPassword: string) {
    const userKeys = await unlockUserKeys(api, keyPassword);
    const { Addresses } = await api.request('GET', 'core/v4/addresses');

    const addresses: ProtonDriveAccountAddress[] = [];
    // Public halves of every own address key, active or not, keyed by lowercase
    // email: old files may be signed by keys that have since been deactivated.
    const verificationKeys = new Map<string, PublicKey[]>();

    for (const address of [...Addresses].sort((a: any, b: any) => a.Order - b.Order)) {
        verificationKeys.set(
            address.Email.toLowerCase(),
            await Promise.all(address.Keys.map((k: any) => CryptoProxy.importPublicKey({ armoredKey: k.PrivateKey }))),
        );
        if (address.Status !== ADDRESS_ENABLED) continue;

        const keys = [];
        let primaryKeyIndex = 0;
        for (const k of address.Keys) {
            if (k.Active !== 1) continue;
            // Modern accounts encrypt each address key's passphrase to the user
            // key (Token) and sign it; legacy keys share the key password.
            let passphrase = keyPassword;
            if (k.Token) {
                const { data, verificationStatus } = await CryptoProxy.decryptMessage({
                    armoredMessage: k.Token,
                    decryptionKeys: userKeys,
                    armoredSignature: k.Signature,
                    verificationKeys: userKeys,
                });
                if (verificationStatus !== VERIFICATION_STATUS.SIGNED_AND_VALID) {
                    throw new Error(`Address key token for ${address.Email} has an invalid signature`);
                }
                passphrase = data;
            }
            if (k.Primary === 1) primaryKeyIndex = keys.length;
            keys.push({ id: k.ID, key: await CryptoProxy.importPrivateKey({ armoredKey: k.PrivateKey, passphrase }) });
        }
        if (keys.length) addresses.push({ email: address.Email, addressId: address.ID, primaryKeyIndex, keys });
    }
    if (!addresses.length) throw new Error('No usable addresses on this account');
    return { addresses, verificationKeys };
}

export async function loadAccount(api: Api, keyPassword: string): Promise<ProtonDriveAccount> {
    const { addresses, verificationKeys } = await unlockAddresses(api, keyPassword);

    if (process.env.DEBUG_LOGIN) {
        for (const [email, keys] of verificationKeys) {
            console.log(`[debug] own keys for ${email}: ${keys.map((k) => k.getKeyID()).join(', ')}`);
        }
    }

    // Errors propagate: silently returning "no keys" turns a failed lookup
    // into a signature-verification failure, which hides the real cause.
    const lookup = (email: string) =>
        api.request('GET', `core/v4/keys/all?Email=${encodeURIComponent(email)}&InternalOnly=0`);

    return {
        getOwnPrimaryAddress: async () => addresses[0],
        getOwnAddresses: async () => addresses,
        getOwnAddress: async (emailOrAddressId) => {
            const needle = emailOrAddressId.toLowerCase();
            const found = addresses.find((a) => a.addressId === emailOrAddressId || a.email.toLowerCase() === needle);
            if (!found) throw new Error(`No own address ${emailOrAddressId}`);
            return found;
        },
        hasProtonAccount: async (email) => (await lookup(email)).IsProton === 1,
        getPublicKeys: async (email) => {
            const own = verificationKeys.get(email.toLowerCase());
            if (own) return own;
            const { Address } = await lookup(email);
            return Promise.all((Address?.Keys ?? []).map((k: any) => CryptoProxy.importPublicKey({ armoredKey: k.PublicKey })));
        },
    };
}
