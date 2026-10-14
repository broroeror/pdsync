// Spike: log in, build the SDK client, and list the top level of My Files.
// Read-only, and nothing is written to disk.
import { MemoryCache, ProtonDriveClient } from '@protontech/drive-sdk';
import { Api, ApiError } from './api.ts';
import { loadAccount } from './account.ts';
import { initCrypto, openPGPModule, srpModule } from './crypto.ts';
import { login } from './login.ts';
import { ask } from './prompt.ts';

console.log('This is a third-party application not officially supported by Proton.\n');

initCrypto();
const api = new Api();

try {
    const username = await ask('Username: ');
    const password = await ask('Password: ', { hidden: true });
    const { keyPassword } = await login(api, username, password, {
        totp: () => ask('2FA code: '),
        mailboxPassword: () => ask('Mailbox password: ', { hidden: true }),
    });
    console.log('Logged in.');

    const client = new ProtonDriveClient({
        httpClient: api.httpClient(),
        entitiesCache: new MemoryCache(),
        cryptoCache: new MemoryCache(),
        account: await loadAccount(api, keyPassword),
        openPGPCryptoModule: openPGPModule(),
        srpModule: srpModule(api),
    });

    const root = await client.getMyFilesRootFolder();
    console.log(`\nMy Files (${root.uid}):`);
    let count = 0;
    for await (const node of client.iterateFolderChildren(root)) {
        const name = node.name.ok ? node.name.value : `<undecryptable: ${'message' in node.name.error ? node.name.error.message : node.name.error.error}>`;
        console.log(`  ${node.type === 'folder' ? '[dir] ' : '      '}${name}`);
        count++;
    }
    console.log(count ? `\n${count} item(s).` : '  (empty)');
} catch (error) {
    if (error instanceof ApiError) {
        console.error(`\nAPI error: HTTP ${error.status}, code ${error.code}: ${error.message}`);
        console.error(JSON.stringify(error.body, null, 2));
    } else {
        console.error('\n', error);
    }
    process.exitCode = 1;
}
