// Offline check: the address-key unlock path from account.ts, on fake keys.
import { CryptoProxy, VERIFICATION_STATUS } from '@protontech/crypto';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier } from '@protontech/crypto/srp';
import { initCrypto } from '../src/crypto.ts';

initCrypto();
const keyPassword = await computeKeyPassword('hunter2', generateKeySalt());

const userKey = await CryptoProxy.generateKey({ userIDs: [{ name: 'u' }] });
const armoredUser = await CryptoProxy.exportPrivateKey({ privateKey: userKey, passphrase: keyPassword });

const addrPassphrase = 'address-key-passphrase';
const addrKey = await CryptoProxy.generateKey({ userIDs: [{ email: 'a@example.com' }] });
const armoredAddr = await CryptoProxy.exportPrivateKey({ privateKey: addrKey, passphrase: addrPassphrase });
const { message: Token, signature: Signature } = await CryptoProxy.encryptMessage({
    textData: addrPassphrase, encryptionKeys: userKey, signingKeys: userKey, detached: true,
});

// The same steps account.ts performs.
const unlockedUser = await CryptoProxy.importPrivateKey({ armoredKey: armoredUser, passphrase: keyPassword });
const { data, verificationStatus } = await CryptoProxy.decryptMessage({
    armoredMessage: Token, decryptionKeys: [unlockedUser], armoredSignature: Signature, verificationKeys: [unlockedUser],
});
await CryptoProxy.importPrivateKey({ armoredKey: armoredAddr, passphrase: data });
console.log('token decrypted:', data === addrPassphrase, '| signature valid:', verificationStatus === VERIFICATION_STATUS.SIGNED_AND_VALID);

let wrongRejected = false;
try { await CryptoProxy.importPrivateKey({ armoredKey: armoredUser, passphrase: 'wrong' }); } catch { wrongRejected = true; }
console.log('wrong password rejected:', wrongRejected);
