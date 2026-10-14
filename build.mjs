// Bundles the engine into dist/pdsync.mjs (no tsx or preload needed at runtime).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

await build({
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
console.log('built dist/pdsync.mjs');
