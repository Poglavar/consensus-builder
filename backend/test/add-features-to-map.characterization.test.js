// Proposal derivation publishes GeoJSON into one private fabric draft. It does not build, style,
// index, or incrementally add Leaflet layers; ParcelPresenter prepares those at commit.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const { createLiveParcelFabric } = require('../../frontend/js/parcels/live-fabric.js');
require('../../frontend/js/proposal-parcel-identity.js');

const polygon = (id, properties = {}) => ({
    type: 'Feature',
    properties: { parcelId: id, cadastreParcelIds: [id], ...properties },
    geometry: { type: 'Polygon', coordinates: [[[15.87, 43.75], [15.88, 43.75], [15.88, 43.76], [15.87, 43.75]]] }
});

let previousWindow;
let fabric;

beforeEach(() => {
    previousWindow = global.window;
    fabric = createLiveParcelFabric();
    global.window = { LiveParcelFabric: fabric };
});

afterEach(() => {
    global.window = previousWindow;
});

describe('_addFeaturesToMap is a fabric write despite its historical name', () => {
    it('fails closed outside a live-fabric transaction', async () => {
        await expect(ProposalManager._addFeaturesToMap([polygon('HR-A')]))
            .rejects.toThrow(/active live-fabric transaction/);
    });

    it('writes the complete batch to the private draft and publishes it only at commit', async () => {
        const token = fabric.beginTransaction({ kind: 'proposal' });
        const features = Array.from({ length: 250 }, (_, index) => polygon(`HR-${index}`));

        const ids = await ProposalManager._addFeaturesToMap.call({}, features, true, null, {
            _fabricTransaction: token
        });
        expect(ids).toHaveLength(250);
        expect(fabric.list()).toHaveLength(0);
        expect(fabric.list({ transaction: token })).toHaveLength(250);

        await fabric.commit(token);
        expect(fabric.list()).toHaveLength(250);
    });

    it('publishes ordinary and explicitly-provenanced generated parcels through the same path', async () => {
        const token = fabric.beginTransaction({ kind: 'proposal' });
        await ProposalManager._addFeaturesToMap.call({}, [
            polygon('HR-A'),
            polygon('generated-track', {
                cadastreParcelIds: ['HR-A'], producedByProposalId: 'road', isTrack: true, isRoad: true
            })
        ], false, null, { _fabricTransaction: token });

        expect(fabric.get('HR-A', { transaction: token })).not.toBeNull();
        expect(fabric.get('generated-track', { transaction: token })).not.toBeNull();
        fabric.rollback(token);
    });

    it('remains awaitable while doing no presentation work', async () => {
        const token = fabric.beginTransaction({ kind: 'proposal' });
        const result = ProposalManager._addFeaturesToMap.call(
            {},
            [polygon('HR-A')],
            false,
            null,
            { _fabricTransaction: token }
        );
        expect(typeof result.then).toBe('function');
        await expect(result).resolves.toEqual(['HR-A']);
        fabric.rollback(token);
    });
});
