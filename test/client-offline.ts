// Offline check: the SDK client constructs with our modules (no network).
import { MemoryCache, ProtonDriveClient } from '@protontech/drive-sdk';
import { Api } from '../src/api.ts';
import { initCrypto, openPGPModule, srpModule } from '../src/crypto.ts';

initCrypto();
const api = new Api();
const fail = async (): Promise<never> => { throw new Error('offline'); };
const client = new ProtonDriveClient({
    httpClient: api.httpClient(),
    entitiesCache: new MemoryCache(),
    cryptoCache: new MemoryCache(),
    account: { getOwnPrimaryAddress: fail, getOwnAddresses: fail, getOwnAddress: fail, hasProtonAccount: fail, getPublicKeys: fail },
    openPGPCryptoModule: openPGPModule(),
    srpModule: srpModule(api),
});
console.log('client constructed:', typeof client.getMyFilesRootFolder === 'function');
