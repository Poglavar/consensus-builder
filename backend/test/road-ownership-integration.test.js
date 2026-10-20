// Verify road UI statistics preserve unknown ownership and explicit valuation currencies.
import { afterEach, describe, expect, it } from 'vitest';
import { loadRoadDrawing } from './helpers/road-drawing-env.js';

let env = null;

function load(parcels) {
    env = loadRoadDrawing({ parcels });
    env.session.roadAffectedParcels = parcels.map(parcel => ({ id: parcel.id, area: parcel.properties.calculatedArea }));
    return env;
}

afterEach(() => {
    env?.dispose();
    env = null;
});

const parcel = (id, properties) => ({
    id,
    ring: [[15.977, 45.813], [15.9771, 45.813], [15.9771, 45.8131], [15.977, 45.8131], [15.977, 45.813]],
    properties: { calculatedArea: 100, ...properties }
});

describe('road drawing ownership and acquisition statistics', () => {
    it('keeps known owner-list entries visible while an unlisted parcel makes the complete count unknown', () => {
        const world = load([
            parcel('listed', { ownershipType: 'company', ownershipList: ['Owner A', 'Owner B'] }),
            parcel('unlisted', { ownershipType: 'government' })
        ]);

        expect(world.api.collectOwnershipAndAcquisitionStats()).toMatchObject({
            ownerEntryCount: null,
            knownOwnerEntryCount: 2,
            missingOwnerEvidenceParcelCount: 1,
            unknownOwnershipParcelCount: 0
        });
    });

    it('sums same-currency estimates and withholds totals for mixed or missing source currencies', () => {
        const sameCurrency = load([
            parcel('eur-a', { estimatedMarketPrice: 1200, estimatedMarketPriceCurrency: 'EUR' }),
            parcel('eur-b', { estimatedMarketPrice: 800, estimatedMarketPriceCurrency: 'EUR' })
        ]);

        expect(sameCurrency.api.collectOwnershipAndAcquisitionStats()).toMatchObject({
            totalMarketPrice: 2000,
            currency: 'EUR',
            priceBasis: { kind: 'source-estimate' }
        });

        sameCurrency.dispose();
        env = load([
            parcel('eur', { estimatedMarketPrice: 1200, estimatedMarketPriceCurrency: 'EUR' }),
            parcel('usd', { estimatedMarketPrice: 800, estimatedMarketPriceCurrency: 'USD' })
        ]);
        expect(env.api.collectOwnershipAndAcquisitionStats()).toMatchObject({
            totalMarketPrice: null,
            currency: null,
            priceBasis: { kind: 'mixed-currency' }
        });

        env.dispose();
        env = load([
            parcel('uncoded', { estimatedMarketPrice: 1200 })
        ]);
        expect(env.api.collectOwnershipAndAcquisitionStats()).toMatchObject({
            totalMarketPrice: null,
            currency: null,
            priceBasis: { kind: 'unknown-component' }
        });
    });
});
