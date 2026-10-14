// Offline check: a public key can be imported from an armored *locked* private
// key (so even inactive address keys can verify old signatures).
import { CryptoProxy } from '@protontech/crypto';
import { initCrypto } from '../src/crypto.ts';

initCrypto();
const key = await CryptoProxy.generateKey({ userIDs: [{ email: 'a@example.com' }] });
const locked = await CryptoProxy.exportPrivateKey({ privateKey: key, passphrase: 'secret' });
const pub = await CryptoProxy.importPublicKey({ armoredKey: locked });
const signature = await CryptoProxy.signMessage({ textData: 'hello', signingKeys: key, detached: true });
const { verificationStatus } = await CryptoProxy.verifyMessage({ textData: 'hello', armoredSignature: signature, verificationKeys: pub });
console.log('public key from locked private key verifies:', verificationStatus === 1, '| keyID', pub.getKeyID());
