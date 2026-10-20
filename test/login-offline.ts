// Offline check of the human-verification (9001) retry in login.
import assert from 'node:assert/strict';
import { ApiError } from '../src/api.ts';
import { checkUrl, withHumanVerification, type HumanCheck } from '../src/login.ts';

const challenge = (token: string, webUrl = `https://verify.proton.me/?methods=captcha&token=${token}`) =>
    new ApiError(422, 9001, 'Human verification required', {
        Code: 9001,
        Details: { HumanVerificationToken: token, HumanVerificationMethods: ['captcha', 'email'], WebUrl: webUrl },
    });

// The check page is used only if it really is verify.proton.me.
assert.equal(checkUrl('https://verify.proton.me/?methods=captcha&token=T1', 'T1', ['captcha']), 'https://verify.proton.me/?methods=captcha&token=T1');
assert.equal(checkUrl('https://evil.example/verify', 'T2', ['captcha']), 'https://verify.proton.me/?methods=captcha&token=T2');
assert.equal(checkUrl('http://verify.proton.me/x', 'T3', ['email']), 'https://verify.proton.me/?methods=email&token=T3');
assert.equal(checkUrl(undefined, 'T 4', ['captcha', 'email']), 'https://verify.proton.me/?methods=captcha%2Cemail&token=T%204');
console.log('✓ only ever opens verify.proton.me');

// Challenge once, then accepted when the same token is presented.
const shown: HumanCheck[] = [];
const seen: (Record<string, string> | undefined)[] = [];
const result = await withHumanVerification(
    { totp: async () => '', mailboxPassword: async () => '', humanVerification: async (check) => void shown.push(check) },
    async (headers) => {
        seen.push(headers);
        if (!headers) throw challenge('TOKEN-1');
        return 'logged in';
    },
);
assert.equal(result, 'logged in');
assert.equal(shown.length, 1);
assert.equal(shown[0].url, 'https://verify.proton.me/?methods=captcha&token=TOKEN-1');
assert.deepEqual(seen[1], { 'x-pm-human-verification-token': 'TOKEN-1', 'x-pm-human-verification-token-type': 'captcha,email' });
console.log('✓ after the check, the whole step is retried with the same token');

// Other errors pass straight through; no check is shown.
await assert.rejects(
    withHumanVerification({ totp: async () => '', mailboxPassword: async () => '', humanVerification: async () => assert.fail('no check') }, async () => {
        throw new ApiError(422, 8002, 'Incorrect login credentials', {});
    }),
    /Incorrect login credentials/,
);
// Gives up after three checks.
let rounds = 0;
await assert.rejects(
    withHumanVerification({ totp: async () => '', mailboxPassword: async () => '', humanVerification: async () => void rounds++ }, async () => {
        throw challenge('AGAIN');
    }),
    /Human verification required/,
);
assert.equal(rounds, 3);
// Cancelling the check cancels the login.
await assert.rejects(
    withHumanVerification({ totp: async () => '', mailboxPassword: async () => '', humanVerification: async () => { throw new Error('Login cancelled'); } }, async () => {
        throw challenge('X');
    }),
    /Login cancelled/,
);
console.log('✓ other errors pass through; gives up after 3 checks; cancelling stops the login');
