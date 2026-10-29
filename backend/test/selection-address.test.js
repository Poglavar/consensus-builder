// The address names the click stack's selection (frontend/js/selection-address.js): one parameter,
// replaced on every selection, dropped with none; a record link gives way to it.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const SelectionAddress = createRequire(import.meta.url)('../../frontend/js/selection-address.js');
const { selectionOf, withSelection, read, idOf } = SelectionAddress;
const selectedInstance = (stack, kind) => {
    const section = stack.sections.find(item => item.kind === kind);
    return section ? section.instances[section.selectedIndex] : null;
};
const stack = (expanded, sections) => ({ expanded, selectedKind: expanded, sections: Object.entries(sections)
    .map(([kind, instances]) => ({ kind, instances, selectedIndex: 0 })) });

describe('the selection a stack names', () => {
    it('is the expanded section\'s selected object, by the id that reopens it', () => {
        expect(selectionOf(stack('designs', { designs: [{ id: 'design-1', proposal: {} }] }), selectedInstance)).toEqual({ kind: 'designs', id: 'design-1' });
        expect(selectionOf(stack('designs', { designs: [{ id: 'design-bafyd', proposal: { published: true } }] }), selectedInstance, record => record.published ? 'bafyd' : null)).toEqual({ kind: 'designs', id: 'bafyd' });
        expect(selectionOf(stack('designs', { designs: [{ id: 'row-7', serverId: 'bafyd' }] }), selectedInstance)).toEqual({ kind: 'designs', id: 'bafyd' });
        expect(selectionOf(stack('plans', { plans: [{ id: 'x', cid: 'bafyp' }] }), selectedInstance)).toEqual({ kind: 'plans', id: 'bafyp' });
        expect(selectionOf(stack('agreements', { agreements: [{ id: 'bafya', localId: 'agreement-3' }] }), selectedInstance)).toEqual({ kind: 'agreements', id: 'agreement-3' });
        expect(selectionOf(stack('agreements', { agreements: [{ id: 'bafya', cid: 'bafya' }] }), selectedInstance)).toEqual({ kind: 'agreements', id: 'bafya' });
    });
    it('names the parcel of the spot for a formed piece, and leaves buildings to the planning inspector', () => {
        const spot = { built: [{ id: 'b-1' }], formed: [{ id: 'piece-1' }], parcels: [{ id: 'HR-335258-4341/2' }] };
        expect(selectionOf(stack('formed', spot), selectedInstance)).toEqual({ kind: 'parcels', id: 'HR-335258-4341/2' });
        expect(selectionOf(stack('built', spot), selectedInstance)).toBeNull();
        expect(selectionOf(stack('ground', { ground: [{ id: 'g' }] }), selectedInstance)).toBeNull();
        expect(selectionOf(null, selectedInstance)).toBeNull();
        expect(idOf('designs', null)).toBeNull();
    });
});

describe('the address with a selection', () => {
    it('holds one selection, keeping the view and every other parameter', () => {
        expect(withSelection('http://x/?at=45.8,15.9,17&lang=hr&design=a', { kind: 'plans', id: 'bafyp' }))
            .toBe('http://x/?at=45.8,15.9,17&lang=hr&plan=bafyp');
        expect(withSelection('http://x/?at=45.8,15.9,17&design=a&plan=b', { kind: 'designs', id: 'a' })).toBe('http://x/?at=45.8,15.9,17&design=a');
        expect(read('?at=1,2,3&parcel=HR-1%2F2')).toEqual({ kind: 'parcels', id: 'HR-1/2' });
    });
    it('drops the selection when nothing is selected, and is unchanged when it already says so', () => {
        expect(withSelection('http://x/?at=45.8,15.9,17&agreement=z', null)).toBe('http://x/?at=45.8,15.9,17');
        expect(withSelection('http://x/?at=45.8,15.9,17', null)).toBeNull();
        expect(withSelection('http://x/?at=45.8,15.9,17&design=a', { kind: 'designs', id: 'a' })).toBeNull();
    });
    it('replaces a link that opened a record, so a reload does not apply its designs again', () => {
        expect(withSelection('http://x/plans/bafyp?at=45.8,15.9,17', { kind: 'plans', id: 'bafyp' })).toBe('http://x/?at=45.8,15.9,17&plan=bafyp');
        expect(withSelection('http://x/designs/bafyd', null)).toBe('http://x/');
        expect(withSelection('http://x/bets/acct', null)).toBeNull();
    });
});
