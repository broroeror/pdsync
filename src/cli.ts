// Entry point: npm run pdsync -- <command>
import os from 'node:os';
import path from 'node:path';
import { ApiError } from './api.ts';
import { acquireLock } from './lock.ts';
import { getMeta, Mirror, openState, STATE_DIR } from './mirror.ts';
import { installService, serviceStatus, uninstallService } from './service.ts';
import { interactiveLogin, logout, openClient, UserError } from './session.ts';

const USAGE = `Usage: npm run pdsync -- <command>

  login               Log in once; the login is saved in your desktop keyring
  logout              Sign out and remove the saved login
  ls                  List the top level of My Files
  mirror [folder]     Download My Files into a folder (download-only: never
                      deletes or uploads). The folder is remembered after the
                      first run. Add --full to rescan everything.
  service install [minutes]
                      Run the mirror automatically (default every 5 minutes)
  service status      Show when it last ran and runs next
  service uninstall   Stop running it automatically`;

async function main(command: string | undefined, args: string[]) {
    switch (command) {
        case 'login':
            return interactiveLogin();
        case 'logout':
            return logout();
        case 'ls': {
            const { client } = await openClient();
            const root = await client.getMyFilesRootFolder();
            for await (const node of client.iterateFolderChildren(root)) {
                const name = node.name.ok ? node.name.value : '<name could not be decrypted>';
                console.log(`${node.type === 'folder' ? '[dir] ' : '      '}${name}`);
            }
            return;
        }
        case 'mirror': {
            const db = openState();
            const given = args.find((a) => !a.startsWith('--'));
            const folder = given ? path.resolve(given) : getMeta(db, 'root_dir');
            if (!folder) throw new UserError('First run: say which folder to mirror into, e.g.  npm run pdsync -- mirror ~/DriveMirror');
            if (folder === path.parse(folder).root || folder === os.homedir()) {
                throw new UserError(`Refusing to mirror straight into ${folder}; pick a dedicated folder.`);
            }
            acquireLock(STATE_DIR);
            const { client } = await openClient();
            const mirror = new Mirror(client, db, folder);
            await mirror.run({ full: args.includes('--full') });

            const parts = [`${mirror.downloaded} downloaded`];
            if (mirror.skipped) parts.push(`${mirror.skipped} skipped (see ! lines)`);
            if (mirror.failures) parts.push(`${mirror.failures} failed; they will be retried next run`);
            console.log(`\nMirror at ${folder}: ${parts.join(', ')}.`);
            if (mirror.failures) process.exitCode = 1;
            return;
        }
        case 'service': {
            const [action, minutes] = args;
            if (action === 'install') return installService(openState(), minutes ? Number(minutes) : undefined);
            if (action === 'uninstall') return uninstallService();
            if (action === 'status') return serviceStatus();
            throw new UserError('Usage: npm run pdsync -- service install|status|uninstall');
        }
        default:
            console.log(USAGE);
            if (command && command !== 'help') process.exitCode = 1;
    }
}

const [command, ...args] = process.argv.slice(2);
try {
    await main(command, args);
} catch (error) {
    if (error instanceof UserError) {
        console.error(error.message);
    } else if (error instanceof ApiError) {
        console.error(`API error: HTTP ${error.status}, code ${error.code}: ${error.message}`);
    } else {
        console.error(error);
    }
    process.exitCode = 1;
}
