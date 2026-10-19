// Publication attaches a row reference to one exact local record without changing its key.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/proposals/server-sync.js', import.meta.url), 'utf8');

function setup(records) {
    const store = {
        proposals: new Map(records.map(record => [record.proposalId, record])),
        getProposal: vi.fn(() => records[0]),
        _indexProposal: vi.fn(record => store.proposals.set(record.proposalId, record)),
        save: vi.fn()
    };
    const context = vm.createContext({ proposalStorage: store, console });
    vm.runInContext(source, context);
    return { sync: context.syncProposalWithServerId, store };
}

describe('publication row identity', () => {
    it.each([undefined, 'local-draft', 'c2-content', '19'])('records the returned row without retaining an unrelated id (%s)', previousId => {
        const local = { proposalId: 'p-local-draft', ...(previousId ? { id: previousId } : {}) };
        const { sync, store } = setup([local]);
        expect(sync({ ...local }, 42)).toBe(local);
        expect(local).toEqual({ proposalId: 'p-local-draft', id: '42', serverProposalId: '42' });
        expect([...store.proposals.keys()]).toEqual(['p-local-draft']);
        expect(store._indexProposal).toHaveBeenCalledExactlyOnceWith(local);
        expect(store.save).toHaveBeenCalledOnce();
        expect(store.getProposal).not.toHaveBeenCalled();
    });

    it('does not attach publication to a record found only by an alias', () => {
        const unrelated = { proposalId: 'p-another', tokenId: '77' };
        const { sync, store } = setup([unrelated]);
        expect(sync({ proposalId: '77' }, 42)).toBeNull();
        expect(unrelated).toEqual({ proposalId: 'p-another', tokenId: '77' });
        expect(store.save).not.toHaveBeenCalled();
        expect(store.getProposal).not.toHaveBeenCalled();
    });

    it.each([null, '', 'authored-id', '0', '-1', '4.2'])('rejects a non-row publication result (%s)', rowId => {
        const local = { proposalId: 'p-local' };
        const { sync, store } = setup([local]);
        expect(() => sync(local, rowId)).toThrow(/database proposal row ID/);
        expect(local).toEqual({ proposalId: 'p-local' });
        expect(store.save).not.toHaveBeenCalled();
    });
});
