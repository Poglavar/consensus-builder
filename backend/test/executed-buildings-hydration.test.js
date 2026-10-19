// Characterization test for loadExecutedBuildingsFromStorage (frontend/js/building-blocks.js):
// an APPLIED building proposal must come back on the map after a page reload.
//
// Why it exists: #showProposedBuildings has no `checked` attribute and its state is persisted
// nowhere, so it starts UNCHECKED on every load. The first render used to be gated on that box
// being checked, which meant an applied freeform/block proposal was hydrated into memory and then
// never drawn — it looked like the proposal had not survived the refresh, while roads (no such
// gate) came back fine. The proposal was in storage the whole time.
//
// building-blocks.js is a classic browser script with no exports, so it is evaluated in THIS realm
// behind DOM/Leaflet stubs, the same way urban-rule-manual-simplify.test.js does it.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as turf from '@turf/turf';

const buildingFeature = (proposalId, index) => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[15.97, 45.81], [15.9701, 45.81], [15.9701, 45.8101], [15.97, 45.8101], [15.97, 45.81]]] },
    properties: { proposalId, buildingIndex: index, height: 12 }
});

const appliedFreeformProposal = {
    proposalId: 'freeform-1',
    goal: 'single',
    title: 'Freeform 1',
    parentParcelIds: ['HR-335550-1'],
    applied: true,
    buildingProposal: { applied: true, parentParcelIds: ['HR-335550-1'] },
    geometry: { buildings: [buildingFeature('freeform-1', 0)] }
};

let cap;
let checkbox;
let scheduled;

beforeAll(() => {
    global.turf = turf;
    const noop = () => { };
    const stub = () => ({ addTo() { return this; }, on() { return this; }, bindTooltip() { return this; }, setLatLng: noop, getLatLng: () => ({ lat: 0, lng: 0 }) });
    global.L = { geoJSON: stub, polygon: stub, polyline: stub, marker: stub, layerGroup: stub, featureGroup: stub, divIcon: () => ({}), map: () => ({ removeLayer: noop, addLayer: noop, fitBounds: noop, on: noop }) };

    checkbox = { checked: false };
    global.document = {
        getElementById: id => (id === 'showProposedBuildings'
            ? checkbox
            : { classList: { add: noop, remove: noop }, style: {}, addEventListener: noop, setAttribute: noop }),
        createElement: () => ({}),
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: noop
    };
    global.window = { addEventListener: noop, removeEventListener: noop, confirm: () => true, document: global.document, dispatchEvent: noop, CustomEvent: class { } };
    global.THREE = undefined;
    global.highlightBlock = noop;
    global.showBuildingAlert = noop;
    global.translateBuildingText = (_k, fallback) => fallback;
    global.isApplied = (proposal, sub) => !!((sub && sub.applied) || (proposal && proposal.applied));
    global.proposalStorage = { getAllProposals: () => [appliedFreeformProposal] };
    global.map = { removeLayer: noop, addLayer: noop };

    // Capture scheduled work instead of waiting on real timers.
    scheduled = [];
    global.setTimeout = fn => { scheduled.push(fn); return 0; };

    const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../../frontend/js/building-blocks.js');
    let src = readFileSync(scriptPath, 'utf8');
    src += `
        globalThis.__cap = {
            loadExecutedBuildingsFromStorage,
            proposedBuildings: () => proposedBuildings,
            spyOnLayerUpdate: fn => { updateProposedBuildingsLayer = fn; }
        };`;
    // eslint-disable-next-line no-eval
    (0, eval)(src);
    cap = globalThis.__cap;
});

describe('loadExecutedBuildingsFromStorage', () => {
    it('hydrates an applied building proposal back into the proposed-buildings pool', () => {
        checkbox.checked = false;
        scheduled = [];
        cap.loadExecutedBuildingsFromStorage();

        const pool = cap.proposedBuildings();
        expect(pool.some(f => f?.properties?.proposalId === 'freeform-1')).toBe(true);
    });

    it('shows them even though the visibility box starts unchecked after a reload', () => {
        checkbox.checked = false;
        scheduled = [];
        let renders = 0;
        cap.spyOnLayerUpdate(() => { renders += 1; });

        cap.loadExecutedBuildingsFromStorage();

        // The box is turned on — this is the state every creation path leaves behind, and an
        // applied building is part of the map, not an opt-in overlay.
        expect(checkbox.checked).toBe(true);
        // ...and the layer is actually scheduled to draw. Without this the proposal is in memory
        // and invisible, which is exactly what "it did not survive the refresh" looked like.
        expect(scheduled.length).toBeGreaterThan(0);
        scheduled.forEach(fn => fn());
        expect(renders).toBeGreaterThan(0);
    });
});
