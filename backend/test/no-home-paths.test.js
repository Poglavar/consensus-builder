// Keeps personal home-directory paths out of this public repository: a macOS home path
// (/Users/<name>/...) or a scratchpad path built from one (-Users-<name>-...) in any tracked
// file fails here, before it is pushed. Point at sibling checkouts relatively (../repo) or via
// $HOME instead.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Assembled from parts so this file's own source never matches it.
const HOME_PATH = ['/Users', '/[A-Za-z0-9._-]+/', '|-Users-[A-Za-z0-9]+-'].join('');

function trackedFilesMatching(pattern) {
    try {
        return execFileSync('git', ['grep', '-l', '-I', '-E', pattern], { cwd: repoRoot, encoding: 'utf8' })
            .trim().split('\n');
    } catch (error) {
        if (error.status === 1) return []; // git grep exits 1 when nothing matches
        throw error;
    }
}

describe('public repository hygiene', () => {
    it('has no personal home-directory paths in tracked files', () => {
        expect(trackedFilesMatching(HOME_PATH)).toEqual([]);
    });
});
