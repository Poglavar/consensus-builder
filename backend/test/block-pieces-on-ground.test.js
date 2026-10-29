// A Block or Row stands on the map as pieces cut by the parcels under it now
// (UrbanRuleVariation.piecesOnGround): its saved pieces while it stands on the lots it was drawn on,
// its saved massing cut again by today's parcels once those lots are gone (a parcel layout it was
// drawn on came off the map and the block was left standing).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import UrbanRuleVariation from '../../frontend/js/urban-rule-variation.js';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');

const box = (west, south, east, north) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] } });
// A ring 150 m across with a courtyard, like a perimeter block.
const ring = () => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [
    [[16.000, 45.000], [16.002, 45.000], [16.002, 45.0014], [16.000, 45.0014], [16.000, 45.000]],
    [[16.0003, 45.0002], [16.0003, 45.0012], [16.0017, 45.0012], [16.0017, 45.0002], [16.0003, 45.0002]]] } });
const rule = typology => UrbanRuleVariation.normalizeBlockRule({ typology, kind: 'range', maxHeightM: 17.5, minHeightM: 7, floorHeightM: 3.5 });
const massingFor = typology => UrbanRuleVariation.massingWithRule(ring(), rule(typology), 731, { turf });
// The parcel layout's lots: west and east halves. Today's cadastre: south and north halves.
const lots = [{ feature: box(16.000, 45.000, 16.001, 45.0014), parcelId: 'layout#1' }, { feature: box(16.001, 45.000, 16.002, 45.0014), parcelId: 'layout#2' }];
const cadastre = [{ feature: box(16.000, 45.000, 16.002, 45.0007), parcelId: 'HR-1/1' }, { feature: box(16.000, 45.0007, 16.002, 45.0014), parcelId: 'HR-1/2' }];
const area = features => features.reduce((sum, feature) => sum + turf.area(feature), 0);

describe('the pieces a Block stands as on its ground', () => {
    it('are its saved pieces while it stands on the lots it was drawn on', () => {
        const massing = massingFor('block');
        const saved = UrbanRuleVariation.splitMassingByParcels(massing, lots, rule('block'), 731, { turf }).pieces;
        expect(saved.map(piece => piece.properties.parcelId)).toEqual(['layout#1', 'layout#2']);
        expect(UrbanRuleVariation.piecesOnGround(saved, massing, lots, { turf })).toBe(saved);
    });

    it('are its massing cut by today\'s parcels once those lots are gone, with nothing of the old lots left', () => {
        for (const typology of ['block', 'row']) {
            const massing = massingFor(typology);
            const saved = UrbanRuleVariation.splitMassingByParcels(massing, lots, rule(typology), 731, { turf }).pieces;
            const now = UrbanRuleVariation.piecesOnGround(saved, massing, cadastre, { turf });
            expect(now.map(piece => piece.properties.parcelId)).toEqual(['HR-1/1', 'HR-1/2']);
            // Each piece lies inside its own parcel, and together they are the whole massing again.
            now.forEach((piece, index) => expect(turf.area(turf.intersect(piece, cadastre[index].feature))).toBeCloseTo(turf.area(piece), 0));
            expect(area(now)).toBeCloseTo(turf.area(massing), 0);
            expect(now.every(piece => piece.properties.urbanRule.typology === typology)).toBe(true);
        }
    });

    it('are one building again when the lots it was drawn on are now one parcel, and a lone piece on a larger parcel stands as saved', () => {
        const massing = massingFor('block');
        const whole = [{ feature: box(15.9995, 44.9995, 16.0025, 45.0019), parcelId: 'HR-1' }];
        // Saved records carry no live parcel ids: the pieces are recognised by where they lie.
        const strip = pieces => pieces.map(piece => ({ ...piece, properties: { ...piece.properties, parcelId: undefined } }));
        const saved = strip(UrbanRuleVariation.splitMassingByParcels(massing, lots, rule('block'), 731, { turf }).pieces);
        const now = UrbanRuleVariation.piecesOnGround(saved, massing, whole, { turf });
        expect(now.map(piece => piece.properties.parcelId)).toEqual(['HR-1']);
        expect(turf.area(now[0])).toBeCloseTo(turf.area(massing), 0);
        const lone = strip(UrbanRuleVariation.splitMassingByParcels(massing, [lots[0]], rule('block'), 731, { turf }).pieces);
        expect(UrbanRuleVariation.piecesOnGround(lone, massing, whole, { turf })).toBe(lone);
    });

    it('leaves anything that is not a rule massing as it was saved', () => {
        const saved = [box(16.000, 45.000, 16.001, 45.001)];
        expect(UrbanRuleVariation.piecesOnGround(saved, ring(), cadastre, { turf })).toBe(saved);
        expect(UrbanRuleVariation.piecesOnGround(saved, null, cadastre, { turf })).toBe(saved);
        expect(UrbanRuleVariation.piecesOnGround(saved, massingFor('block'), [], { turf })).toBe(saved);
    });
});
