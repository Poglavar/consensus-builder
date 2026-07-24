// Pure placement geometry and snapping tests for the placeable transit-station tool.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const previousModels = globalThis.TransitStationModels;
globalThis.TransitStationModels = require('../../frontend/js/vendor/transit-station-models.js');
const alignments = require('../../frontend/js/transit-alignments.js');
const stations = require('../../frontend/js/transit-stations.js');

afterEach(() => {
    globalThis.transitStations = [];
});

afterAll(() => {
    if (previousModels === undefined) delete globalThis.TransitStationModels;
    else globalThis.TransitStationModels = previousModels;
});

function rectangle(west, south, east, north, id) {
    return turf.polygon([[[west, south], [east, south], [east, north], [west, north], [west, south]]], {
        parcelId: id
    });
}

describe('transit station footprints', () => {
    it.each([
        ['bus', 5, 18],
        ['tram', 5, 18],
        ['underground', 32, 68],
        ['elevated', 24, 30]
    ])('builds the configured %s footprint in metres', (type, expectedWidth, expectedLength) => {
        const geometry = stations.createStationFootprint([15.98, 45.81], 0, type, turf);
        const ring = geometry.coordinates[0];
        const width = turf.distance(turf.point(ring[0]), turf.point(ring[1]), { units: 'meters' });
        const length = turf.distance(turf.point(ring[0]), turf.point(ring[3]), { units: 'meters' });

        expect(width).toBeCloseTo(expectedWidth, 1);
        expect(length).toBeCloseTo(expectedLength, 1);
        const expectedArea = expectedWidth * expectedLength;
        expect(Math.abs(turf.area(turf.feature(geometry)) - expectedArea) / expectedArea).toBeLessThan(0.005);
    });

    it('rotates the long axis to the requested geographic bearing', () => {
        const geometry = stations.createStationFootprint([15.98, 45.81], 90, 'tram', turf);
        const ring = geometry.coordinates[0];
        const midpoint = turf.midpoint(turf.point(ring[0]), turf.point(ring[1]));
        const center = turf.point([15.98, 45.81]);

        expect(turf.bearing(center, midpoint)).toBeCloseTo(90, 1);
    });
});

describe('station placement alignment', () => {
    it('snaps to the nearest applied corridor and adopts its bearing', () => {
        const proposals = [{
            proposalId: 'road-east-west',
            applied: true,
            roadProposal: {
                definition: {
                    points: [[
                        { lng: 15.979, lat: 45.81 },
                        { lng: 15.981, lat: 45.81 }
                    ]]
                }
            }
        }, {
            proposalId: 'parked-road',
            applied: false,
            roadProposal: {
                definition: {
                    points: [[
                        { lng: 15.98, lat: 45.809 },
                        { lng: 15.98, lat: 45.811 }
                    ]]
                }
            }
        }];

        const result = stations.nearestCorridorAlignment([15.98, 45.81008], 24, turf, proposals);

        expect(result.proposalId).toBe('road-east-west');
        expect(result.distanceM).toBeLessThan(10);
        expect(result.center[0]).toBeCloseTo(15.98, 5);
        expect(result.center[1]).toBeCloseTo(45.81, 6);
        expect(result.bearing).toBeCloseTo(90, 1);
    });

    it('does not snap outside the placement radius', () => {
        const proposals = [{
            proposalId: 'road',
            applied: true,
            roadProposal: {
                definition: { points: [[{ lng: 15.979, lat: 45.81 }, { lng: 15.981, lat: 45.81 }]] }
            }
        }];

        expect(stations.nearestCorridorAlignment([15.98, 45.811], 24, turf, proposals)).toBeNull();
    });

    it('snaps rail stations only to rail-bearing corridor segments', () => {
        const road = {
            proposalId: 'road', applied: true,
            roadProposal: { definition: {
                width: 10,
                profile: { strips: [{ type: 'driving', width: 10 }] },
                points: [[{ lng: 15.979, lat: 45.81 }, { lng: 15.981, lat: 45.81 }]]
            } }
        };
        const rail = {
            proposalId: 'rail', applied: true,
            roadProposal: { definition: {
                width: 6,
                profile: { strips: [{ type: 'rail', width: 6 }] },
                points: [[{ lng: 15.979, lat: 45.8101 }, { lng: 15.981, lat: 45.8101 }]]
            } }
        };

        const result = stations.nearestCorridorAlignment([15.98, 45.81002], 24, turf, [road, rail], 'tram');
        expect(result).toMatchObject({ proposalId: 'rail', alignmentKind: 'rail' });
        expect(result.center[1]).toBeCloseTo(45.8101, 6);
        expect(stations.nearestCorridorAlignment([15.98, 45.81], 24, turf, [road], 'underground')).toBeNull();
    });

    it('places bus stations beside drivable roads and aligns each side with traffic', () => {
        const road = {
            proposalId: 'road', applied: true,
            roadProposal: { definition: {
                width: 10,
                profile: { strips: [{ type: 'driving', width: 10 }] },
                points: [[{ lng: 15.979, lat: 45.81 }, { lng: 15.981, lat: 45.81 }]]
            } }
        };
        const rail = {
            proposalId: 'rail', applied: true,
            roadProposal: { definition: {
                width: 6,
                profile: { strips: [{ type: 'rail', width: 6 }] },
                points: [[{ lng: 15.979, lat: 45.81005 }, { lng: 15.981, lat: 45.81005 }]]
            } }
        };

        const northSide = stations.nearestCorridorAlignment([15.98, 45.81006], 24, turf, [rail, road], 'bus');
        expect(northSide).toMatchObject({ proposalId: 'road', alignmentKind: 'roadside', side: 'left' });
        expect(northSide.center[1]).toBeGreaterThan(45.81);
        expect(northSide.bearing).toBeCloseTo(270, 1);
        expect(turf.distance(turf.point(northSide.centerlineCenter), turf.point(northSide.center), { units: 'meters' })).toBeCloseTo(8, 1);
        expect(stations.nearestCorridorAlignment([15.98, 45.81005], 24, turf, [rail], 'bus')).toBeNull();
    });

    it('allows both rail and bus stations on a mixed tram street', () => {
        const mixed = {
            proposalId: 'mixed', applied: true,
            roadProposal: { definition: {
                width: 12,
                profile: { strips: [{ type: 'driving', width: 8 }, { type: 'rail', width: 4 }] },
                points: [[{ lng: 15.979, lat: 45.81 }, { lng: 15.981, lat: 45.81 }]]
            } }
        };
        expect(stations.nearestCorridorAlignment([15.98, 45.81], 24, turf, [mixed], 'tram')?.proposalId).toBe('mixed');
        expect(stations.nearestCorridorAlignment([15.98, 45.81], 24, turf, [mixed], 'bus')?.proposalId).toBe('mixed');
    });

    it('snaps tram stations to OSM tram alignments but rejects incompatible station types', () => {
        const references = alignments.buildAlignmentRecords({
            id: 'zagreb-tram', url: 'tram.geojson', mode: 'tram',
            stationTypes: ['tram'], elevationM: 0, render3d: 'surface'
        }, {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature', properties: { osmId: 195825111 },
                geometry: { type: 'LineString', coordinates: [[15.979, 45.81], [15.981, 45.81]] }
            }]
        });

        const result = stations.nearestCorridorAlignment(
            [15.98, 45.81004], 24, turf, [], 'tram', references
        );
        expect(result).toMatchObject({
            sourceKind: 'reference', sourceId: 'zagreb-tram', featureId: '195825111',
            mode: 'tram', elevationM: 0, alignmentKind: 'rail'
        });
        expect(result.center[1]).toBeCloseTo(45.81, 6);
        expect(stations.nearestCorridorAlignment(
            [15.98, 45.81004], 24, turf, [], 'elevated', references
        )).toBeNull();
        expect(stations.nearestCorridorAlignment(
            [15.98, 45.81004], 24, turf, [], 'bus', references
        )).toBeNull();
    });

    it('inherits an existing elevated railway height and records a durable reference attachment', () => {
        const references = alignments.buildAlignmentRecords({
            id: 'zagreb-heavy-rail', url: 'rail.geojson', mode: 'heavy-rail',
            stationTypes: ['elevated'], elevationM: 7.5, render3d: 'elevated'
        }, {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature', properties: { osmId: 4323187 },
                geometry: { type: 'LineString', coordinates: [[15.979, 45.81], [15.981, 45.81]] }
            }]
        });
        const snap = stations.nearestCorridorAlignment(
            [15.98, 45.81003], 24, turf, [], 'elevated', references
        );
        const update = stations.placementUpdateFromAlignment('elevated', snap, 10);

        expect(update.platformHeightM).toBe(7.5);
        expect(update.alignment).toMatchObject({
            kind: 'rail', sourceKind: 'reference', sourceId: 'zagreb-heavy-rail',
            featureId: '4323187', mode: 'heavy-rail', elevationM: 7.5,
            proposalId: null
        });
        expect(update.alignment.lineSegmentIndex).toBe(0);
        expect(update.alignment.measureM).toBeGreaterThan(0);
        expect(update.alignment.snapDistanceM).toBeGreaterThan(0);
    });

    it('resolves the carried preview as red off-track and green only after a legal snap', () => {
        const references = alignments.buildAlignmentRecords({
            id: 'zagreb-tram', url: 'tram.geojson', mode: 'tram',
            stationTypes: ['tram'], elevationM: 0, render3d: 'surface'
        }, {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature', properties: { osmId: 195825111 },
                geometry: { type: 'LineString', coordinates: [[15.979, 45.81], [15.981, 45.81]] }
            }]
        });
        const parcelEntries = [{
            id: 'track-parcel',
            feature: rectangle(15.978, 45.8095, 15.982, 45.8105, 'track-parcel')
        }];

        const snapped = stations.resolvePlacementPreview('tram', [15.98, 45.81004], {
            turfApi: turf,
            proposals: [],
            referenceAlignments: references,
            parcelEntries
        });
        expect(snapped).toMatchObject({
            aligned: true,
            valid: true,
            reason: null,
            parentParcelIds: ['track-parcel']
        });
        expect(snapped.center[1]).toBeCloseTo(45.81, 6);

        const offTrack = stations.resolvePlacementPreview('tram', [15.98, 45.812], {
            turfApi: turf,
            proposals: [],
            referenceAlignments: references,
            parcelEntries
        });
        expect(offTrack).toMatchObject({ aligned: false, valid: false, reason: 'no-alignment' });
        expect(offTrack.center).toEqual([15.98, 45.812]);

        const outsideLoadedParcels = stations.resolvePlacementPreview('tram', [15.98, 45.81004], {
            turfApi: turf,
            proposals: [],
            referenceAlignments: references,
            parcelEntries: []
        });
        expect(outsideLoadedParcels).toMatchObject({
            aligned: true,
            valid: false,
            reason: 'no-loaded-parcel'
        });
    });

    it('filters the emphasized alignments to the selected station type', () => {
        const references = [{ stationTypes: ['tram'], points: [[15.97, 45.81], [15.98, 45.81]] },
            { stationTypes: ['elevated'], points: [[15.97, 45.82], [15.98, 45.82]] }];
        const road = {
            proposalId: 'road', applied: true,
            roadProposal: { definition: {
                profile: { strips: [{ type: 'driving', width: 10 }] },
                points: [[{ lng: 15.979, lat: 45.81 }, { lng: 15.981, lat: 45.81 }]]
            } }
        };
        const rail = {
            proposalId: 'rail', applied: true,
            roadProposal: { definition: {
                profile: { strips: [{ type: 'rail', width: 6 }] },
                points: [[{ lng: 15.979, lat: 45.8101 }, { lng: 15.981, lat: 45.8101 }]]
            } }
        };

        expect(stations.compatibleReferenceAlignments('tram', references)).toEqual([references[0]]);
        expect(stations.compatibleReferenceAlignments('elevated', references)).toEqual([references[1]]);
        expect(stations.compatibleProposalAlignments('tram', [road, rail]).map(entry => entry.sourceId)).toEqual(['rail']);
        expect(stations.compatibleProposalAlignments('bus', [road, rail]).map(entry => entry.sourceId)).toEqual(['road']);
    });
});

describe('station geometry editing', () => {
    it('rotates around the fixed centre and carries elevated height into the edited structure', () => {
        const center = [15.98, 45.81];
        const original = {
            kind: 'station',
            stationType: 'elevated',
            center,
            bearing: 0,
            platformHeightM: 10,
            geometry: stations.createStationFootprint(center, 0, 'elevated', turf),
            demolishedBuildings: [{ id: 'old-impact' }],
            demolitionScanned: true,
            parentParcelIds: ['original-parent']
        };
        const edited = stations.buildEditedStationStructure(original, {
            bearing: 90,
            platformHeightM: 17.5
        }, turf, []);

        expect(edited.center).toEqual(center);
        expect(edited.bearing).toBe(90);
        expect(edited.platformHeightM).toBe(17.5);
        expect(edited.geometry).not.toEqual(original.geometry);
        expect(edited.demolishedBuildings).toBeNull();
        expect(edited.demolitionScanned).toBe(false);
        expect(edited.parentParcelIds).toEqual(['original-parent']);
        expect(original.bearing).toBe(0);
    });

    it('clamps elevated platform height but removes it from surface station types', () => {
        expect(stations.normalizePlatformHeight(100, 'elevated')).toBe(40);
        expect(stations.normalizePlatformHeight(-5, 'elevated')).toBe(3);
        const bus = stations.buildEditedStationStructure({
            stationType: 'bus', center: [15.98, 45.81], bearing: 0,
            platformHeightM: 25,
            geometry: stations.createStationFootprint([15.98, 45.81], 0, 'bus', turf)
        }, { bearing: 45 }, turf, []);
        expect(bus).not.toHaveProperty('platformHeightM');
    });

    it('opens a fixed-centre elevated editor with rotation and height controls', async () => {
        const keys = [
            'map', 'L', 'document', 'turf', 'proposalDraftStore', 'ProposalSelection',
            'hideProposalDetailsPanel', 'hideParcelInfoPanel', 'isProposalDesignCommitSession',
            'finishProposalDraftDesignSession'
        ];
        const originals = new Map(keys.map(key => [key, globalThis[key]]));
        let panel = null;
        const makeLayer = () => ({ addTo() { return this; }, clearLayers() {} });
        const classList = { add() {}, remove() {} };
        globalThis.map = {
            getPane: () => ({ style: {} }), createPane: () => ({ style: {} }), removeLayer() {}
        };
        globalThis.L = {
            layerGroup: makeLayer,
            featureGroup: makeLayer,
            geoJSON: () => ({ addTo() { return this; } }),
            polyline: () => ({ addTo() { return this; } }),
            marker: () => ({ addTo() { return this; } }),
            divIcon: options => options
        };
        globalThis.document = {
            body: {
                appendChild(value) { panel = value; }
            },
            createElement: () => ({
                className: '', classList, innerHTML: '', dataset: {},
                setAttribute() {}, addEventListener() {}, removeEventListener() {},
                querySelector: () => null, remove() {}
            }),
            addEventListener() {}, removeEventListener() {}, getElementById: () => null
        };
        globalThis.turf = turf;
        globalThis.ProposalSelection = { getKey: () => 'station-1' };
        globalThis.hideProposalDetailsPanel = () => {};
        globalThis.hideParcelInfoPanel = () => {};
        globalThis.isProposalDesignCommitSession = () => false;
        let finishedDraftId = null;
        globalThis.finishProposalDraftDesignSession = id => { finishedDraftId = id; };
        const draft = {
            id: 'station-draft', adapterKey: 'station', sourceProposalId: 'station-1',
            editorPayload: { structureProposal: {
                stationType: 'elevated', center: [15.98, 45.81], bearing: 20,
                platformHeightM: 14,
                geometry: stations.createStationFootprint([15.98, 45.81], 20, 'elevated', turf)
            } }
        };

        try {
            expect(stations.openStationGeometryEditor(draft)).toBe(true);
            expect(globalThis.transitStationGeometryEditorActive).toBe(true);
            expect(panel.innerHTML).toContain('data-station-editor-bearing');
            expect(panel.innerHTML).toContain('data-station-editor-height');
            expect(panel.innerHTML).not.toMatch(/latitude|longitude/i);
            await stations.cancelStationGeometryEditor();
            expect(globalThis.transitStationGeometryEditorActive).toBe(false);
            expect(finishedDraftId).toBe('station-draft');
        } finally {
            await stations.cancelStationGeometryEditor();
            for (const [key, value] of originals.entries()) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        }
    });
});

describe('applied station selection hit targets', () => {
    it('selects the station proposal from both the complete footprint and its letter marker', () => {
        const keys = [
            'map', 'L', 'selectAndHighlightProposal', 'showProposalDetails', 'hideParcelInfoPanel',
            'transitStations', 'roadDrawingMode', 'transitStationPlacementMode',
            'isTransitStationPlacementActive', 'isStructureGeometryEditorActive',
            'isTransitStationGeometryEditorActive', 'areaMonitorDrawingMode',
            'isAreaMonitorDrawingActive', '__openProposalDetailsCollapsed'
        ];
        const originals = new Map(keys.map(key => [key, globalThis[key]]));
        const geometryLayers = [];
        const markers = [];
        const mapClicks = [];
        const makeEventLayer = (options = {}) => {
            const handlers = new Map();
            return {
                options,
                handlers,
                on(type, handler) { handlers.set(type, handler); return this; },
                addTo() { return this; }
            };
        };
        const group = { clearLayers() {}, addTo() { return this; } };
        const panes = new Map();
        const select = vi.fn();
        const hideParcel = vi.fn();
        const stop = vi.fn();
        const stopPropagation = vi.fn();
        globalThis.map = {
            getPane: name => panes.get(name) || null,
            createPane: name => {
                const pane = { style: {} };
                panes.set(name, pane);
                return pane;
            },
            fire: (type, event) => mapClicks.push({ type, event })
        };
        globalThis.L = {
            featureGroup: () => group,
            geoJSON: (_feature, options) => {
                const layer = makeEventLayer(options);
                geometryLayers.push(layer);
                return layer;
            },
            marker: (_latlng, options) => {
                const marker = makeEventLayer(options);
                markers.push(marker);
                return marker;
            },
            divIcon: options => options,
            DomEvent: { stop, stopPropagation }
        };
        globalThis.selectAndHighlightProposal = select;
        globalThis.hideParcelInfoPanel = hideParcel;
        globalThis.roadDrawingMode = false;
        globalThis.transitStationPlacementMode = false;
        globalThis.isTransitStationPlacementActive = () => false;
        globalThis.isStructureGeometryEditorActive = () => false;
        globalThis.isTransitStationGeometryEditorActive = () => false;
        globalThis.areaMonitorDrawingMode = false;
        globalThis.isAreaMonitorDrawingActive = () => false;
        globalThis.transitStations = [{
            type: 'Feature',
            properties: {
                proposalId: 'station-123',
                stationType: 'tram',
                center: [15.98, 45.81],
                bearing: 90,
                parentParcelIds: ['parcel-7']
            },
            geometry: stations.createStationFootprint([15.98, 45.81], 90, 'tram', turf)
        }];

        try {
            stations.updateTransitStationsLayer();

            expect(geometryLayers).toHaveLength(2);
            expect(geometryLayers[0].options).toMatchObject({
                pane: 'transitStationsPane',
                interactive: false
            });
            const hitTarget = geometryLayers[1];
            expect(hitTarget.options).toMatchObject({
                pane: 'transitStationHitPane',
                interactive: true,
                bubblingMouseEvents: false,
                className: 'transit-station-hit-target'
            });
            expect(hitTarget.options.style).toMatchObject({ fill: true, fillOpacity: 0.001 });
            expect(panes.get('transitStationHitPane').style.zIndex).toBe('664');

            const footprintDomEvent = {
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
                stopImmediatePropagation: vi.fn()
            };
            hitTarget.handlers.get('click')({ originalEvent: footprintDomEvent, latlng: { lat: 45.81, lng: 15.98 } });
            expect(select).toHaveBeenLastCalledWith('station-123', 'parcel-7', false, true);
            expect(hideParcel).toHaveBeenCalledTimes(1);
            expect(footprintDomEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1);

            expect(markers).toHaveLength(1);
            expect(markers[0].options).toMatchObject({
                pane: 'transitStationIconsPane',
                interactive: true,
                keyboard: true,
                bubblingMouseEvents: false
            });
            markers[0].handlers.get('click')({ originalEvent: { stopPropagation() {}, preventDefault() {} } });
            expect(select).toHaveBeenCalledTimes(2);
            expect(select).toHaveBeenLastCalledWith('station-123', 'parcel-7', false, true);
            expect(stop).toHaveBeenCalledTimes(2);
            expect(stopPropagation).toHaveBeenCalledTimes(2);

            // A road drawing session still owns map clicks even though station hit targets sit above roads.
            globalThis.roadDrawingMode = true;
            hitTarget.handlers.get('click')({
                originalEvent: {},
                latlng: { lat: 45.81, lng: 15.98 },
                layerPoint: { x: 1, y: 2 },
                containerPoint: { x: 3, y: 4 }
            });
            expect(select).toHaveBeenCalledTimes(2);
            expect(mapClicks).toHaveLength(1);
            expect(mapClicks[0]).toMatchObject({ type: 'click', event: { latlng: { lat: 45.81, lng: 15.98 } } });
        } finally {
            for (const [key, value] of originals.entries()) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        }
    });
});

describe('station placement input ownership', () => {
    it('captures map-surface clicks before parcel layers can select themselves', () => {
        const keys = [
            'map', 'L', 'document', 'turf', 'addEventListener', 'removeEventListener',
            'isThreeModeActive', 'clearParcelHover'
        ];
        const originals = new Map(keys.map(key => [key, globalThis[key]]));
        const handlers = new Map();
        const previewStyles = [];
        let hoverClears = 0;
        const container = {
            style: {},
            addEventListener(type, handler, capture) {
                handlers.set(`${type}:${capture === true}`, handler);
            },
            removeEventListener(type, handler, capture) {
                if (handlers.get(`${type}:${capture === true}`) === handler) handlers.delete(`${type}:${capture === true}`);
            }
        };
        const layer = { addTo() { return this; }, clearLayers() {} };
        globalThis.map = {
            _container: container,
            getContainer: () => container,
            getPane: () => ({ style: {} }),
            createPane: () => ({ style: {} }),
            on(type, handler) { handlers.set(`map:${type}`, handler); },
            off(type, handler) {
                if (handlers.get(`map:${type}`) === handler) handlers.delete(`map:${type}`);
            },
            removeLayer() {},
            mouseEventToLatLng: () => ({ lat: 45.81, lng: 15.98 })
        };
        globalThis.L = {
            featureGroup: () => layer,
            geoJSON: (_feature, options) => {
                previewStyles.push(options?.style || null);
                return { addTo() { return this; } };
            },
            polyline: () => ({ addTo() { return this; } }),
            marker: () => ({ addTo() { return this; } }),
            divIcon: options => options
        };
        globalThis.document = {
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => []
        };
        globalThis.turf = turf;
        globalThis.addEventListener = () => {};
        globalThis.removeEventListener = () => {};
        globalThis.isThreeModeActive = () => false;
        globalThis.clearParcelHover = () => { hoverClears += 1; };

        try {
            expect(stations.startTransitStationPlacement('tram')).toBe(true);
            expect(stations.isTransitStationPlacementActive()).toBe(true);
            expect(globalThis.transitStationPlacementMode).toBe(true);
            expect(hoverClears).toBe(1);
            handlers.get('map:mousemove')?.({ latlng: { lat: 45.812, lng: 15.98 } });
            expect(previewStyles.at(-1)).toMatchObject({ color: '#dc2626', dashArray: '8 5' });
            const click = handlers.get('click:true');
            expect(click).toBeTypeOf('function');
            let prevented = false;
            let stopped = false;
            click({
                button: 0,
                clientX: 100,
                clientY: 120,
                target: { closest: () => null },
                preventDefault: () => { prevented = true; },
                stopImmediatePropagation: () => { stopped = true; }
            });
            expect(prevented).toBe(true);
            expect(stopped).toBe(true);
            expect(stations.cancelTransitStationPlacement()).toBe(true);
            expect(stations.isTransitStationPlacementActive()).toBe(false);
            expect(globalThis.transitStationPlacementMode).toBe(false);
        } finally {
            stations.cancelTransitStationPlacement();
            for (const [key, value] of originals.entries()) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        }
    });

    it('registers station placement as a parcel drawing mode fallback', () => {
        const source = readFileSync(new URL('../../frontend/js/parcels/state.js', import.meta.url), 'utf8');
        expect(source).toContain('global.transitStationPlacementMode');
        expect(source).toContain('global.isTransitStationPlacementActive()');
    });

    it('keeps parcel hover and programmatic parcel selection inert during placement', () => {
        const keys = [
            'transitStationPlacementMode', 'highlightFeature', 'resetHighlight', 'clearParcelHover',
            'onEachFeature', 'restoreParcelLayerStyle', 'selectParcel', 'AreaMonitorPaint'
        ];
        const originals = new Map(keys.map(key => [key, globalThis[key]]));
        const parcelLayerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'parcelLayer');
        let parcelLayerReads = 0;
        let styleChanges = 0;
        try {
            globalThis.transitStationPlacementMode = true;
            globalThis.AreaMonitorPaint = null;
            Object.defineProperty(globalThis, 'parcelLayer', {
                configurable: true,
                get() {
                    parcelLayerReads += 1;
                    return null;
                }
            });
            delete require.cache[require.resolve('../../frontend/js/parcels/selection.js')];
            require('../../frontend/js/parcels/selection.js');

            globalThis.highlightFeature({
                target: {
                    feature: rectangle(15.97, 45.80, 15.98, 45.81, 'parcel-1'),
                    setStyle() { styleChanges += 1; }
                }
            });
            globalThis.selectParcel('parcel-1');

            expect(styleChanges).toBe(0);
            expect(parcelLayerReads).toBe(0);
        } finally {
            if (parcelLayerDescriptor) Object.defineProperty(globalThis, 'parcelLayer', parcelLayerDescriptor);
            else delete globalThis.parcelLayer;
            for (const [key, value] of originals.entries()) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        }
    });
});

describe('station parcel ancestry', () => {
    it('returns every loaded parcel intersected by the station footprint', () => {
        const geometry = rectangle(15.9798, 45.8098, 15.9802, 45.8102, 'footprint').geometry;
        const entries = [
            { id: 'west', feature: rectangle(15.9795, 45.8095, 15.98, 45.8105, 'west') },
            { id: 'east', feature: rectangle(15.98, 45.8095, 15.9805, 45.8105, 'east') },
            { id: 'far', feature: rectangle(15.99, 45.82, 15.991, 45.821, 'far') }
        ];

        expect(stations.findStationParentParcelIds(geometry, turf, entries).sort()).toEqual(['east', 'west']);
    });
});

describe('underground station surface cut-outs', () => {
    it('opens only compact entrances while leaving the hall roof covered', () => {
        const station = {
            type: 'Feature',
            properties: { stationType: 'underground', center: [15.98, 45.81], bearing: 35 },
            geometry: stations.createStationFootprint([15.98, 45.81], 35, 'underground', turf)
        };
        const cuts = stations.stationSurfaceCutouts(station, turf);
        const totalCutArea = cuts.reduce((sum, geometry) => sum + turf.area(turf.feature(geometry)), 0);
        const footprintArea = turf.area(station);

        expect(cuts).toHaveLength(3);
        expect(totalCutArea).toBeLessThan(footprintArea * 0.2);
        expect(cuts.every(geometry => turf.booleanWithin(turf.feature(geometry), station))).toBe(true);
    });

    it('does not cut the ground for surface or elevated stations', () => {
        for (const stationType of ['bus', 'tram', 'elevated']) {
            const geometry = stations.createStationFootprint([15.98, 45.81], 0, stationType, turf);
            expect(stations.stationSurfaceCutouts({
                type: 'Feature', properties: { stationType, center: [15.98, 45.81] }, geometry
            }, turf)).toEqual([]);
        }
    });
});
