// Round-trip through the real desktop keyring. Refuses to run if a saved
// login already exists, so it can never clobber one.
import assert from 'node:assert/strict';
import { clearSecret, loadSecret, saveSecret } from '../src/keyring.ts';

if (await loadSecret()) throw new Error('A saved login exists; not running the keyring test');
const value = JSON.stringify({ test: 'pdsync keyring round-trip', unicode: 'äöü ✓' });
await saveSecret(value);
assert.equal(await loadSecret(), value);
await clearSecret();
assert.equal(await loadSecret(), null);
console.log('✓ keyring save / load / clear');
