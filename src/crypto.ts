// Crypto wiring: Proton's CryptoProxy runs in-process (the web app uses a
// worker so the UI doesn't freeze; a CLI/daemon has no UI to freeze).
import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { getSrp, getRandomSrpVerifier, computeKeyPassword, generateKeySalt } from '@protontech/crypto/srp';
import { OpenPGPCryptoWithCryptoProxy, ProtonDriveClient } from '@protontech/drive-sdk';
import type { Api } from './api.ts';

// The SDK doesn't export SRPModule, so take it from the constructor's parameters.
type SRPModule = ConstructorParameters<typeof ProtonDriveClient>[0]['srpModule'];

let initialised = false;

export function initCrypto() {
    if (initialised) return;
    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
    initialised = true;
}

export function openPGPModule() {
    return new OpenPGPCryptoWithCryptoProxy(CryptoProxy as any);
}

/** Adapts Proton's SRP helpers to the shape the SDK expects (used for share passwords). */
export function srpModule(api: Api): SRPModule {
    return {
        getSrp: async (version, modulus, serverEphemeral, salt, password) =>
            getSrp({ Version: version, Modulus: modulus, ServerEphemeral: serverEphemeral, Salt: salt }, { password }),
        getSrpVerifier: async (password) => {
            const { Modulus, ModulusID } = await api.request('GET', 'core/v4/auth/modulus');
            const { version, salt, verifier } = await getRandomSrpVerifier({ Modulus }, { password });
            return { modulusId: ModulusID, version, salt, verifier };
        },
        computeKeyPassword,
        generateKeySalt,
    };
}
