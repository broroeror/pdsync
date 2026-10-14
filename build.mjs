// Bundles the engine into dist/pdsync.mjs (no tsx or preload needed at runtime).
import { build } from 'esbuild';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

const result = await build({
    metafile: true,
    entryPoints: ['src/main.ts'],
    outfile: 'dist/pdsync.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Keep third-party license notices next to the bundle.
    legalComments: 'linked',
    define: { PDSYNC_PACKAGED: 'true', PDSYNC_VERSION: JSON.stringify(version) },
    // Some bundled dependencies are CommonJS and call require().
    banner: { js: "import { createRequire as __pdsyncRequire } from 'node:module'; const require = __pdsyncRequire(import.meta.url);" },
    plugins: [
        {
            // @protontech/crypto imports the browser-only `openpgp/lightweight`;
            // the package's default entry is the same library built for Node.
            name: 'openpgp-node',
            setup(b) {
                b.onResolve({ filter: /^openpgp\/lightweight$/ }, (args) =>
                    b.resolve('openpgp', { kind: args.kind, resolveDir: args.resolveDir }),
                );
            },
        },
    ],
    logLevel: 'warning',
});

// Full license text of every bundled package (MIT and friends require
// shipping it with copies of the code).
const packageDirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
    const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match) packageDirs.add(match[1]);
}
const sections = [];
for (const dir of [...packageDirs].sort()) {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    const text = file ? readFileSync(path.join(dir, file), 'utf8').trim() : `License: ${pkg.license ?? 'unknown'} (no license file shipped)`;
    sections.push(`${pkg.name}@${pkg.version} (${pkg.license ?? 'unknown'})\n${'-'.repeat(60)}\n${text}`);
}
writeFileSync('dist/THIRD-PARTY-LICENSES.txt', sections.join('\n\n\n') + '\n');
console.log(`built dist/pdsync.mjs (${packageDirs.size} bundled packages, licenses in dist/THIRD-PARTY-LICENSES.txt)`);
