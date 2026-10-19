// Prevents legacy chain consent controls from signing a proposal with abstract approval semantics.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = name => readFileSync(new URL(`../../frontend/js/proposals/${name}.js`, import.meta.url), 'utf8');

describe('approval lens boundaries', () => {
    it('shows the adapter limitation without wiring attestation, consent or verdict transactions', async () => {
        const section = { isConnected: true, innerHTML: '', textContent: '',
            querySelector() { throw new Error('Unsupported consent controls must not bind.'); },
            querySelectorAll() { throw new Error('Unsupported consent controls must not bind.'); } };
        const window = {
            LensCore: { validateSolanaLens: rows => ({ keys: rows }), shortKey: key => key, isBase58Pubkey: () => true },
            LensServiceClient: { fetchDirectory: async () => ({ outcome: { kind: 'ok' }, members: [{ key: 'member-a', name: 'Member A' }] }) },
            getBackendBase: () => 'https://example.test',
            solanaWalletManager: { getState() { throw new Error('Wallet must not be opened.'); } }
        };
        vm.runInNewContext(read('lens-card'), { window, console });
        await window.ProposalLensCard.mount(section, {
            resolveLens: () => ['member-a'], parcelIds: ['parcel-a'], proposalAccount: 'proposal-account', approvalUnsupported: true
        });
        expect(section.innerHTML).toContain('Member A');
        expect(section.innerHTML).toContain('not supported by the current chain adapter');
        expect(section.innerHTML).not.toContain('data-lens-submit-verdict');
        expect(section.innerHTML).not.toContain('proposal-lens-parcels');
    });

    it('preserves exact case-sensitive lens keys through storage normalization', () => {
        const source = read('storage');
        const start = source.indexOf('function normalizeLensEntries(');
        const end = source.indexOf('\nfunction getProposalLensEntries(', start);
        const context = vm.createContext({});
        vm.runInContext(source.slice(start, end), context);
        expect(context.normalizeLensEntries(['MemberA', 'memberA', { key: 'MemberB' }, { address: 'MemberA' }]))
            .toEqual([{ address: 'MemberA', name: '' }, { address: 'memberA', name: '' }, { address: 'MemberB', name: '' }]);
    });
});
