// Offline check of exclusion patterns.
import assert from 'node:assert/strict';
import { DEFAULT_EXCLUDES, makeExcluder } from '../src/exclude.ts';

const ex = makeExcluder([...DEFAULT_EXCLUDES, 'Projects/old-stuff', '*.iso', 'Temp?']);
const yes = (rel: string) => assert.equal(ex(rel), true, `${rel} should be excluded`);
const no = (rel: string) => assert.equal(ex(rel), false, `${rel} should be synced`);

yes('node_modules');
yes('app/node_modules/react/index.js');
yes('repo/.git/HEAD');
yes('src/__pycache__/x.cpython-314.pyc');
yes('lib/thing.pyc');
yes('Projects/old-stuff');
yes('Projects/old-stuff/a/b.txt');
yes('Downloads/ubuntu.iso');
yes('Temp1/notes.txt');
no('Projects/old-stuff-but-newer/a.txt');
no('Projects/new-stuff/old-stuff.txt');
no('my node_modules notes.txt');
no('git-tips.md');
no('Docs/.gitignore');
no('Temp12/notes.txt');
no('photo.iso.jpg');
assert.equal(makeExcluder([])('anything'), false);
console.log('✓ exclusion patterns: names anywhere, paths by prefix, * and ?');
