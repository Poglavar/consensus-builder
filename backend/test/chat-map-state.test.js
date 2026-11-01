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
    it('supplies the current source for corridor and station drafting without injecting parcel selection or overwriting an explicit source', () => {
        const context = { city: 'london', parcelSourceId: 'source', selection: { parcelIds: ['a'] } };
        for (const name of ['ugt_draft_road', 'ugt_draft_track', 'ugt_draft_station']) {
            expect(injectMapArgs(name, { point: [-0.1, 51.5] }, context)).toEqual({ point: [-0.1, 51.5], city: 'london', parcelSourceId: 'source' });
            expect(injectMapArgs(name, { city: 'elsewhere', parcelSourceId: 'explicit' }, context)).toEqual({ city: 'elsewhere', parcelSourceId: 'explicit' });
        }
        expect(injectMapArgs('ugt_modify_design', { design: 'existing' }, context)).toEqual({ design: 'existing' });
    });
    it('anchors random starting parcels to the current view unless a resolved location was supplied', () => {
        const context = { city: 'london', parcelSourceId: 'source', view: { at: '51.5,-0.1,17' } };
        expect(injectMapArgs('ugt_select_parcels', { action: 'random', radiusM: 100 }, context))
            .toMatchObject({ city: 'london', parcelSourceId: 'source', point: [-0.1, 51.5], radiusM: 100 });
        expect(injectMapArgs('ugt_select_parcels', { action: 'random', point: [-0.08, 51.507], direction: 'southwest' }, context))
            .toMatchObject({ point: [-0.08, 51.507], direction: 'southwest' });
        expect(injectMapArgs('ugt_select_parcels', { action: 'random' }, { view: { at: 'bad' } })).not.toHaveProperty('point');
        expect(injectMapArgs('ugt_select_parcels', { action: 'step', direction: 'south', distance: 100 }, context)).not.toHaveProperty('point');
    });
    it('does not issue commands for failed tools and retains search coverage facts', () => {
        expect(navigationResult('ugt_map_view', { isError: true, structuredContent: { view: { at: '0,0,17' } } })).toBeNull();
        const result = JSON.parse(compactForModel('ugt_find_place', { candidates: [], partial: true, truncated: true, noMatch: false, warnings: ['Incomplete source'] }));
        expect(result).toMatchObject({ partial: true, truncated: true, noMatch: false, warnings: ['Incomplete source'] });
        const places = JSON.parse(compactForModel('ugt_find_place', { candidates: [{ kind: 'place', category: 'bridge', title: 'River Bridge', point: [0, 0] }] }));
        expect(places.candidates[0]).toMatchObject({ category: 'bridge', title: 'River Bridge', point: [0, 0] });
    });
});
