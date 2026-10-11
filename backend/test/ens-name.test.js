import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../../frontend/js/ens/ens-name.js');

describe('proposalEnsName', () => {
    const proposalEnsName = globalThis.proposalEnsName;

    it('keeps legacy numeric proposal labels', () => {
        expect(proposalEnsName('51')).toBe('51.proposals.urbangametheory.eth');
    });

    it('uses a short chain-qualified label from the canonical mirror id', () => {
        const proposal = { chainMirrorProposalId: `chain_${'a'.repeat(64)}` };
        expect(proposalEnsName(proposal)).toBe(`chain-${'a'.repeat(48)}.proposals.urbangametheory.eth`);
        expect(`chain-${'a'.repeat(48)}`.length).toBeLessThan(63);
    });

    it('does not generate a name from a bare token id or malformed mirror id', () => {
        expect(proposalEnsName({ tokenId: '51', chainId: '84532' })).toBe('');
        expect(proposalEnsName({ proposalId: 'chain_not-a-hash' })).toBe('');
    });
});
