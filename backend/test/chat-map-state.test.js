import { describe, expect, it } from 'vitest';
import { injectMapArgs, navigationResult, searchBounds } from '../chat/navigation.js';
import { compactForModel } from '../chat/tool-results.js';
describe('chat map state', () => {
    it('injects authoritative state without overriding an explicit site or location', () => {
        const context = { city: 'london', parcelSourceId: 'source', view: { at: '51.5,-0.1,17' }, selection: { parcelIds: ['a'], active: true } };
        expect(injectMapArgs('ugt_map_view', { view: { at: '0,0,1' }, zoomDelta: 1 }, context)).toEqual({ view: context.view, zoomDelta: 1 });
        expect(injectMapArgs('ugt_select_parcels', { selection: { parcelIds: ['fake'] }, action: 'add' }, context)).toMatchObject({ selection: context.selection });
        expect(injectMapArgs('ugt_draft_space', { parcelIds: ['b'] }, context).parcelIds).toEqual(['b']);
        expect(injectMapArgs('ugt_draft_space', { outline: {} }, context).parcelIds).toBeUndefined();
        expect(injectMapArgs('ugt_find_place', { bbox: [1,2,3,4] }, context).bbox).toEqual([1,2,3,4]);
        expect(injectMapArgs('ugt_find_place', {}, context).bbox).toEqual(searchBounds(context.view));
        expect(searchBounds({ at: 'bad' })).toBeNull();
    });
    it('does not issue commands for failed tools and retains search coverage facts', () => {
        expect(navigationResult('ugt_map_view', { isError: true, structuredContent: { view: { at: '0,0,17' } } })).toBeNull();
        const result = JSON.parse(compactForModel('ugt_find_place', { candidates: [], partial: true, truncated: true, noMatch: false, warnings: ['Incomplete source'] }));
        expect(result).toMatchObject({ partial: true, truncated: true, noMatch: false, warnings: ['Incomplete source'] });
    });
});
