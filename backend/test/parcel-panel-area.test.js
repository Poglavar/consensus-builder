// A parcel whose provider states no area (HMLR's INSPIRE polygons) still shows its measured area and a
// land estimate in the parcel panel's Info tab: the panel reads ParcelMenuModel.featureArea.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const ParcelMenuModel = require('../../frontend/js/ui/parcel-menu-model.js');
const CbFormat = require('../../frontend/js/format.js');
const CityMoney = require('../../frontend/js/city-money.js');
const EconomicSources = require('../../frontend/js/economic-sources.js');
const { buildParcelPriceEstimate } = require('../../frontend/js/financials.js');

// The panel's own lines, from the parcel's properties to its price label (showParcelInfoPanel).
const panelSource = readFileSync(new URL('../../frontend/js/parcels/ui/parcel-panel.js', import.meta.url), 'utf8');
function panelFigures(feature) {
    const start = panelSource.indexOf('const props = feature?.properties || {};', panelSource.indexOf('function showParcelInfoPanel('));
    const end = panelSource.indexOf('const ownerLabel', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const london = { id: 'london', currency: { code: 'GBP' }, economics: { sources: ['uk-mhclg-land-2023'] },
        map: { defaultCenter: [51.5097885891913, -0.126303973484058] } };
    const global = { turf, ParcelMenuModel, EconomicSources, ParcelPriceModel: { buildEstimate: buildParcelPriceEstimate },
        CityMoney: CityMoney.forCity(() => london) };
    const context = vm.createContext({ global, CbFormat, feature });
    return vm.runInContext(`(() => { ${panelSource.slice(start, end)}; return { area, formattedArea, estimate }; })()`, context);
}
// About 20 m × 20 m at the Angel, Islington, with no area field, as HMLR serves it.
const square = (lng, lat, side = 0.0003) => ({ type: 'Feature', properties: { parcelId: 'GB-HMLR-BROWSER-v1-1' },
    geometry: { type: 'Polygon', coordinates: [[[lng, lat], [lng + side, lat], [lng + side, lat + side / 1.6], [lng, lat + side / 1.6], [lng, lat]]] } });

describe('parcel panel area', () => {
    it('measures a parcel the provider gives no area for, and prices it at the land rate where it lies', () => {
        const feature = square(-0.1030, 51.5380);
        const measured = turf.area(feature);
        const figures = panelFigures(feature);
        expect(figures.area).toBeCloseTo(measured, 6);
        expect(figures.formattedArea).not.toBe('N/A');
        expect(figures.estimate).toMatchObject({ basis: 'area-model', currency: 'GBP', rate: 5018 });
        expect(figures.estimate.amount).toBeCloseTo(measured * 5018, 3);
        expect(figures.estimate.economicSource.scope).toBe('E09000019 · Islington');
    });

    it('keeps the area the record states over the measured one', () => {
        const feature = square(-0.1030, 51.5380);
        feature.properties.area = 812.5;
        expect(panelFigures(feature).area).toBe(812.5);
        expect(ParcelMenuModel.featureArea(feature, turf)).toBe(812.5);
    });

    it('has no area without a stated area or a geometry', () => {
        expect(ParcelMenuModel.featureArea({ properties: {} }, turf)).toBeNull();
        expect(ParcelMenuModel.featureArea(null, turf)).toBeNull();
        expect(ParcelMenuModel.featureArea(square(-0.1030, 51.5380), null)).toBeNull();
    });
});
