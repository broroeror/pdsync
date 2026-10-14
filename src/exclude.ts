// Exclusions: things never synced in either direction.
//
// A pattern without "/" matches a file or folder NAME anywhere (`node_modules`,
// `*.pyc`); one with "/" matches a PATH inside the synced folder
// (`Projects/old-stuff`), including everything under it. `*` and `?` work as
// in the shell. Excluded items are ignored, never treated as deleted: adding
// an exclusion never removes anything, here or on Drive.
import type { DatabaseSync } from 'node:sqlite';
import { getMeta, setMeta } from './mirror.ts';

/** Always-regenerated clutter: dependencies, VCS internals, caches, build tool state. */
export const DEFAULT_EXCLUDES = [
    'node_modules',
    '.pnpm-store',
    '.git',
    '.hg',
    '.svn',
    '__pycache__',
    '*.pyc',
    '.venv',
    '.tox',
    '.mypy_cache',
    '.pytest_cache',
    '.ruff_cache',
    '.gradle',
    '.next',
    '.nuxt',
    '.cache',
    '.DS_Store',
    'Thumbs.db',
];

export type ExcludeSettings = { defaults: boolean; custom: string[] };

export function excludeSettings(db: DatabaseSync): ExcludeSettings {
    let custom: string[] = [];
    try {
        custom = JSON.parse(getMeta(db, 'exclude') ?? '[]');
    } catch {
        // Ignore a damaged value; it is rewritten on the next save.
    }
    return { defaults: getMeta(db, 'exclude_defaults') !== '0', custom };
}

export function saveExcludeSettings(db: DatabaseSync, settings: ExcludeSettings) {
    const custom = [...new Set(settings.custom.map((p) => p.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean))];
    setMeta(db, 'exclude', JSON.stringify(custom));
    setMeta(db, 'exclude_defaults', settings.defaults ? '1' : '0');
}

function globToRegExp(glob: string) {
    const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    return new RegExp(`^${body}$`);
}

/** A test for "is this path (relative to the synced folder) excluded?" */
export function makeExcluder(patterns: string[]) {
    const names = patterns.filter((p) => !p.includes('/')).map(globToRegExp);
    const paths = patterns.filter((p) => p.includes('/')).map(globToRegExp);
    if (!names.length && !paths.length) return () => false;
    return (rel: string) => {
        const parts = rel.split('/');
        if (parts.some((part) => names.some((re) => re.test(part)))) return true;
        // A path pattern covers the path itself and everything under it.
        for (let i = 1; i <= parts.length; i++) {
            const prefix = parts.slice(0, i).join('/');
            if (paths.some((re) => re.test(prefix))) return true;
        }
        return false;
    };
}

export function excluderFor(db: DatabaseSync) {
    const { defaults, custom } = excludeSettings(db);
    return makeExcluder([...(defaults ? DEFAULT_EXCLUDES : []), ...custom]);
}
