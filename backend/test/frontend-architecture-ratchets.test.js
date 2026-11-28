// Ratchets keeping frontend classic-script isolation and the 10 largest code files from growing.
import { describe, expect, it } from 'vitest';
import {
    checkCodeFileCeilings,
    currentBareEagerScripts,
    diffBareScripts,
    readBareScriptsBaseline,
    readCodeFileCeilings
} from './helpers/frontend-architecture-ratchets.mjs';

describe('frontend architecture ratchets', () => {
    it('flags newly added bare scripts and stale allowlist entries', () => {
        expect(diffBareScripts(['js/a.js', 'js/new-bare.js'], ['js/a.js', 'js/fixed.js'])).toEqual({
            added: ['js/new-bare.js'],
            stale: ['js/fixed.js']
        });
    });

    it('adds no new eager script failing assertScopeIsolated (allowlist only shrinks)', () => {
        const { added, stale } = diffBareScripts(currentBareEagerScripts(), readBareScriptsBaseline());
        expect(
            added,
            'New eager scripts in frontend/index.html must be single IIFE/UMD expressions passing assertScopeIsolated.'
        ).toEqual([]);
        expect(
            stale,
            'Remove newly isolated scripts from backend/test/fixtures/bare-scripts-baseline.json (run frontend-architecture-ratchets.mjs --write).'
        ).toEqual([]);
    });

    it('detects when a capped code file exceeds its line ceiling', () => {
        const result = checkCodeFileCeilings({ 'frontend/js/three-mode.js': 10 });
        expect(result.exceeded).toHaveLength(1);
        expect(result.exceeded[0].file).toBe('frontend/js/three-mode.js');
    });

    it('keeps the 10 largest frontend code files within their rounded-up 100-line ceilings', () => {
        const { exceeded, missing } = checkCodeFileCeilings(readCodeFileCeilings());
        expect(missing).toEqual([]);
        expect(
            exceeded.map(item => `${item.file}: ${item.lines} > ${item.maxLines}`),
            'Put new logic in a new module, or extract an operation per docs/controller-refactoring.md before growing a capped file.'
        ).toEqual([]);
    });
});
