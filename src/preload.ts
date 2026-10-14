// Loaded before everything else (`--import`). @protontech/crypto imports
// `openpgp/lightweight`, which the openpgp package only publishes for
// browsers. The default entry is the same library (same types) built for
// Node, so redirect that one specifier to it.
import { registerHooks } from 'node:module';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier === 'openpgp/lightweight' ? 'openpgp' : specifier, context);
    },
});

// Node 24 lacks some newer built-ins the SDK and crypto rely on
// (Uint8Array.toBase64/fromBase64 and friends); Proton ships the polyfills.
await import('@protontech/crypto/polyfill');
