import { describe, expect, it, vi } from 'vitest';
import { createMcpNavigation } from '../agents/mcp-navigation.js';
import { injectMapArgs, navigationResult } from '../chat/navigation.js';
import { contextBlock } from '../chat/system-prompt.js';
import { compactForModel } from '../chat/tool-results.js';
import { toModelTools } from '../chat/tool-catalog.js';
const square = (id, w, e) => ({ type: 'Feature', id, properties: { parcelId: id }, geometry: { type: 'Polygon', coordinates: [[[w,0],[e,0],[e,0.001],[w,0.001],[w,0]]] } });
const bridge = { ...square('bridge',0,0.001), properties: { osmId: 'way/1', name: 'River Bridge', category: 'bridge' } };
const readers = (features, source = { osmId: 'way/1', features: [bridge] }, complete = true) => ({ parcels: vi.fn(async () => ({ complete, features })), request: vi.fn(async () => source) });
const nearArgs = { city: 'test', parcelSourceId: 'source', action: 'near', landmark: { osmId: 'way/1', point: [0.0005,0.0005] }, relation: 'edge', direction: 'west' };
describe('chat location integration', () => {
    it('returns label display state and exact live label identity', async () => {
        const read = readers([]), nav = createMcpNavigation({ read }), view = { at: '0,0,18', mode: '2d' };
        expect(nav.mapView({ view, parcelIdsVisible: true })).toEqual({ view, parcelIdsVisible: true });
        expect(() => nav.mapView({ view, parcelIdsVisible: 'true' })).toThrow();
        const result = await nav.selectParcels({ city: 'test', parcelSourceId: 'source', action: 'select', parcelNumber: '17/2', visibleParcels: [{ parcelId: 'live-child', label: '17/2', point: [0,0] }] });
        expect(result).toMatchObject({ selection: { focusParcelId: 'live-child', parcelIds: ['live-child'] }, parcelNumber: '17/2' });
        expect(read.parcels).not.toHaveBeenCalled();
    });
    it('selects a nearby boundary and refuses unavailable geometry or incomplete or distant ground', async () => {
        const read = readers([square('near',-0.0001,-0.00001), square('far',-0.002,-0.001)]);
        const result = await createMcpNavigation({ read }).selectParcels(nearArgs);
        expect(result.selection.parcelIds).toEqual(['near']);
        expect(result.location).toMatchObject({ relation: 'edge', geometryKind: 'outline' });
        expect(result.location.distanceM).toBeLessThan(2);
        expect(read.request).toHaveBeenCalledWith('/places/geometry', { osmId: 'way/1', point: '0.0005,0.0005' });
        await expect(createMcpNavigation({ read: readers([], { osmId:'way/1', features:[] }) }).selectParcels(nearArgs)).rejects.toMatchObject({ code:'landmark-target-unavailable' });
        await expect(createMcpNavigation({ read: readers([], undefined, false) }).selectParcels(nearArgs)).rejects.toMatchObject({ code:'parcel-coverage-incomplete' });
        await expect(createMcpNavigation({ read: readers([square('far',-0.002,-0.001)]) }).selectParcels(nearArgs)).rejects.toMatchObject({ code:'landmark-parcel-not-found' });
    });
    it('uses relay mappings without exposing or accepting model-invented mappings', () => {
        const mapping = [{ parcelId:'relay-only-id',label:'17/2',point:[0,0] }];
        const context = { parcelSourceId:'source', mapContext:{ parcelSourceId:'source',display:{parcelIds:true},visibleParcels:mapping,visibleParcelsTruncated:false,viewBounds:[0,0,0.01,0.01] } };
        expect(injectMapArgs('ugt_select_parcels',{action:'select',parcelNumber:'17/2',visibleParcels:['fake']},context)).toMatchObject({visibleParcels:mapping,bbox:context.mapContext.viewBounds});
        expect(injectMapArgs('ugt_select_parcels',{parcelNumber:'17/2',visibleParcels:['fake']},{})).not.toHaveProperty('visibleParcels');
        expect(() => injectMapArgs('ugt_select_parcels',{parcelNumber:'17/2',parcelSourceId:'other'},context)).toThrow(/another source/);
        expect(contextBlock(context)).toContain('"parcelIds":true');
        expect(contextBlock(context)).not.toContain('relay-only-id');
        const tools = toModelTools([{ name:'ugt_select_parcels',inputSchema:{type:'object',properties:{visibleParcels:{},visibleParcelsTruncated:{},parcelNumber:{type:'string'}}} }]);
        expect(tools[0].input_schema.properties).toEqual({parcelNumber:{type:'string'}});
        expect(navigationResult('ugt_map_view',{view:{at:'0,0,18'},parcelIdsVisible:false})).toEqual({name:'view',data:{view:{at:'0,0,18'},parcelIdsVisible:false}});
    });
    it('retains the exact landmark reference and interpretation in compact results', () => {
        const result = JSON.parse(compactForModel('ugt_find_place',{candidates:[{osmId:'way/1',title:'River Bridge',category:'bridge',point:[0,0]}]}));
        expect(result.candidates[0]).toMatchObject({osmId:'way/1',category:'bridge'});
        expect(JSON.parse(compactForModel('ugt_select_parcels',{location:{osmId:'way/1',relation:'edge',distanceM:5}})).location).toMatchObject({osmId:'way/1',relation:'edge',distanceM:5});
    });
});
