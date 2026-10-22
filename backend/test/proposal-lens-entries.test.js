// Lens member keys are case-sensitive (Solana public keys): proposals/storage.js normalizeLensEntries
// keeps keys that differ only in case apart, reads a key under any of its field names and drops a
// repeated key, so a record's lens list never merges two members into one.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/proposals/storage.js', import.meta.url), 'utf8');

describe('lens entry normalization', () => {
    it('preserves exact case-sensitive lens keys through storage normalization', () => {
        const start = source.indexOf('function normalizeLensEntries(');
        const end = source.indexOf('\nfunction getProposalLensEntries(', start);
        const context = vm.createContext({});
        vm.runInContext(source.slice(start, end), context);
        expect(context.normalizeLensEntries(['MemberA', 'memberA', { key: 'MemberB' }, { address: 'MemberA' }]))
            .toEqual([{ address: 'MemberA', name: '' }, { address: 'memberA', name: '' }, { address: 'MemberB', name: '' }]);
    });
});
