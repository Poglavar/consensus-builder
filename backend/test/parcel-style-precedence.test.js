// An ownership highlight must not paint over parcels that wear their own style (ad parcels,
// roads), in the bulk restyle as well as in the single-parcel style: the two used to disagree.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const PRIVATE_STYLE = { fillColor: '#e74c3c', fillOpacity: 0.3, color: '#a93226', weight: 2 };

function environment() {
    const features = new Map([
        ['ad-plot', { parcelId: 'ad-plot' }],
        ['road-plot', { parcelId: 'road-plot', isRoad: true }],
        ['plain-plot', { parcelId: 'plain-plot' }]
    ].map(([id, properties]) => [id, { type: 'Feature', properties }]));
    const layers = new Map([...features.keys()].map(id => [id, {
        id, options: {}, setStyle(style) { Object.assign(this.options, style); }, bringToFront() {}
    }]));
    const context = {
        console: { log() {}, warn() {} },
        addEventListener() {},
        document: { getElementById: () => null },
        map: { getBounds: () => [0, 0, 1, 1] },
        getParcelsInBounds: () => [...layers.values()],
        LiveParcelFabric: {
            get: id => features.get(id),
            snapshot: () => ({ parcelIds: [...features.keys()] })
        },
        ParcelPresenter: {
            getLayer: id => layers.get(id),
            getLayers: ids => ids.map(id => layers.get(id)).filter(Boolean),
            getIdForLayer: layer => layer?.id
        },
        ParcelsOwnershipHighlight: {
            getSelectedOwnershipTypes: () => new Set(['private individual']),
            typeFor: () => 'private individual',
            styleFor: () => ({ ...PRIVATE_STYLE })
        },
        showAdParcels: true
    };
    context.window = context;
    vm.createContext(context);
    // Made inside the context: styles.js adopts an existing set only if it is that realm's Set.
    context.adParcelIdSet = vm.runInContext("new Set(['ad-plot'])", context);
    vm.runInContext(readFileSync(new URL('../../frontend/js/parcels/styles.js', import.meta.url), 'utf8'), context);
    return { context, layers };
}

describe('parcel style precedence under an ownership highlight', () => {
    it('the bulk restyle keeps an ad parcel in the ad style, as getParcelStyle does', () => {
        const { context, layers } = environment();
        context.refreshParcelStylesForAppliedProposals();
        expect(layers.get('ad-plot').options).toMatchObject(context.adParcelStyle);
        expect(context.getParcelStyle('ad-plot', layers.get('ad-plot'))).toMatchObject(context.adParcelStyle);
    });

    it('keeps a road in the road style and still highlights a plain parcel', () => {
        const { context, layers } = environment();
        context.refreshParcelStylesForAppliedProposals();
        expect(layers.get('road-plot').options).toMatchObject(context.roadStyle);
        expect(layers.get('plain-plot').options).toMatchObject(PRIVATE_STYLE);
        expect(context.getParcelStyle('plain-plot', layers.get('plain-plot'))).toMatchObject(PRIVATE_STYLE);
    });
});
