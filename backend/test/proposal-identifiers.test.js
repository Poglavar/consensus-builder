import { describe, expect, it } from 'vitest';
import { oneProposalByIdentifierClause, partitionProposalIdentifiers, indexProposalRows } from '../proposals/identifiers.js';

describe('proposal lookup namespaces', () => {
    it('selects exactly one SQL identifier column before looking up a record', () => {
        expect(oneProposalByIdentifierClause('51')).toBe('WHERE id::text = $1 LIMIT 1');
        expect(oneProposalByIdentifierClause('c2-design')).toBe('WHERE proposal_id = $1 LIMIT 1');
        expect(oneProposalByIdentifierClause("' OR true --")).toBe('WHERE proposal_id = $1 LIMIT 1');
    });

    it('partitions batch references without copying row IDs into the authored namespace', () => {
        expect(partitionProposalIdentifiers(['51', 'c2-design', 45, 'chain_mirror-key'])).toEqual({
            proposalRowIds: ['51', '45'], authoredProposalIds: ['c2-design', 'chain_mirror-key']
        });
    });

    it('never indexes an authored numeric alias as a row or a chain token as an authored ID', () => {
        const row = { id: 45, proposal_id: '51', onchain_data: { proposalId: 'chain-token' } };
        const indexed = indexProposalRows([row]);
        expect(indexed.get('45')).toBe(row);
        expect(indexed.has('51')).toBe(false);
        expect(indexed.has('chain-token')).toBe(false);
    });
});
