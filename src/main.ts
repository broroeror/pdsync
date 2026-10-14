// Entry point of the bundled build. Imports are evaluated in order, so the
// polyfills (Node lacks some newer built-ins the SDK uses) load before the CLI.
import '@protontech/crypto/polyfill';
import './cli.ts';
