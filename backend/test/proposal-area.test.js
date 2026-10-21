// Whole-source area is required for list comparison and proportional payout estimates.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Area = require('../../frontend/js/proposals/area.js');
const { normalizeParcelIdList } = require('../../frontend/js/proposals/parcel-id.js');
const feature = (parcelId, area) => ({ properties: { parcelId, calculatedArea: area } });
function code(file, start, end) {
    const source = readFileSync(new URL(`../../frontend/js/proposals/${file}.js`, import.meta.url), 'utf8');
    const from = source.indexOf(start), to = source.indexOf(end, from);
    if (from < 0 || to <= from) throw new Error(`Missing ${file} function boundary`);
    return source.slice(from, to);
}

describe('proposal area', () => {
    it('uses available source-area metadata or measures retained geometry without inventing a missing area', () => {
        const geometry = { type: 'Polygon', coordinates: [] };
        const measure = vi.fn(() => 250);
        expect(Area.sourceAreaM2({ properties: { calculated_area: 100 }, geometry }, measure)).toBe(100);
        expect(measure).not.toHaveBeenCalled();
        expect(Area.sourceAreaM2({ properties: {}, geometry }, measure)).toBe(250);
        expect(measure).toHaveBeenCalledWith(geometry);
        expect(Area.sourceAreaM2({ properties: { calculatedArea: 0 } }, measure)).toBeNull();
        expect(Area.sourceAreaM2(null, measure)).toBeNull();
    });

    it('keeps unknown areas distinct from zero and site area distinct from source totals', () => {
        expect(Area.areaSummary()).toMatchObject({ siteAreaM2: null, sourceAreaM2: null, sourceComplete: false });
        expect(Area.areaSummary({ hasSite: true, siteAreaM2: 75, sourceAreas: [100, 200], declaredCount: 2 }))
            .toMatchObject({ siteAreaM2: 75, sourceAreaM2: 300, sourceCount: 2, sourceComplete: true });
        expect(Area.areaSummary({ hasSite: true, siteAreaM2: NaN, sourceAreas: [100, undefined, NaN, 0, -1, '200'], declaredCount: 6 }))
            .toMatchObject({ siteAreaM2: null, sourceAreaM2: 100, sourceCount: 1, declaredCount: 6, sourceComplete: false });
    });

    it('requires every unique declared source before exposing a whole-source total', () => {
        const partial = Area.sourceAreaMap(['a', 'b', 'a'], [feature('a', 100), feature('outside', 800)]);
        expect(partial).toMatchObject({ totalArea: null, sourceAreaM2: 100, declaredCount: 2, sourceCount: 1, sourceComplete: false });
        expect(partial.areaMap.get('b')).toBeNull();
        expect(Area.sourceAreaMap(['a', 'b', 'a'], [feature('a', 100), feature('b', 300)]))
            .toMatchObject({ totalArea: 400, sourceComplete: true, declaredCount: 2 });
        expect(Area.sourceAreaMap()).toMatchObject({ totalArea: null, sourceAreaM2: null });
        expect(Area.sourceAreaM2({ properties: { area: 50, parcelArea: 75 } })).toBeNull();
    });

    it('keeps the site authoritative for the primary extent, even when its area is unknown', () => {
        expect(Area.primaryArea(Area.areaSummary({ hasSite: true, sourceAreas: [500], declaredCount: 1 }))).toBeNull();
        expect(Area.primaryArea(Area.areaSummary({ hasSite: true, siteAreaM2: 75, sourceAreas: [500], declaredCount: 1 }))).toBe(75);
        expect(Area.primaryArea(Area.areaSummary({ sourceAreas: [500], declaredCount: 1 }))).toBe(500);
        expect(Area.primaryArea(Area.areaSummary({ sourceAreas: [500], declaredCount: 2 }))).toBeNull();
    });

    it('uses retained cadastral sources and withholds a payout estimate until the denominator is complete', () => {
        let features = [feature('a', 100)];
        const peekMany = vi.fn(() => features);
        const window = { ProposalArea: Area, CadastralParcelRepository: { peekMany },
            LiveParcelFabric: { get: vi.fn(() => feature('b', 999)) } };
        const context = vm.createContext({ window, normalizeParcelIdList, console,
            getProposalOwnerAcceptanceState: () => ({ entries: [{ key: 'owner', displayName: 'Owner', shareText: '1/1' }] }),
            isProposalExpired: () => false, parseOwnerShareFraction: () => 1,
            proposalRecipientConsentRow: () => null,
            getProposalI18nHelper: () => (_key, fallback) => fallback,
            CbFormat: { formatMoney: (value, currency) => `${value.toFixed(2)} ${currency}` }
        });
        vm.runInContext(code('core', 'function getProposalAreaMap(', '\nfunction resolveProposalIdKey(')
            + code('geometry', 'function computeProposalArea(', '\nfunction computeProposalMetrics(')
            + code('execution', 'function buildOwnerAcceptanceSectionHtml(', '\nfunction getProposalConsentMetrics('), context);
        const proposal = { proposalId: 'p', cadastreParcelIds: ['a', 'b', 'a'], offer: 400, offerCurrency: 'EUR' };
        expect(context.getProposalAreaMap(proposal).totalArea).toBeNull();
        expect(context.computeProposalArea(proposal)).toBeNull();
        expect(context.buildOwnerAcceptanceSectionHtml(proposal, 'a')).not.toContain('owner-payout');
        expect(window.LiveParcelFabric.get).not.toHaveBeenCalled();
        features = [feature('a', 100), feature('b', 300)];
        expect(context.computeProposalArea(proposal)).toBe(400);
        expect(context.buildOwnerAcceptanceSectionHtml(proposal, 'a')).toContain('100.00 EUR');
        expect(context.computeProposalArea({ site: {}, cadastreParcelIds: ['a'] })).toBeNull();
        expect(context.computeProposalArea({ structureProposal: { geometry: {} } })).toBeNull();
        expect(peekMany).toHaveBeenCalledWith(['a', 'b']);
    });

    it('sorts unknown and partial areas last in both list directions', () => {
        const state = { sortKey: 'area-asc' };
        const context = vm.createContext({ window: { ProposalArea: Area }, proposalListState: state });
        vm.runInContext(code('list-ui', 'function sortProposalDataset(', '\n// The lifecycle rung'), context);
        const dataset = [null, 300, 100, NaN].map(area => ({ metrics: { area } }));
        expect(context.sortProposalDataset(dataset).map(row => row.metrics.area)).toEqual([100, 300, null, NaN]);
        state.sortKey = 'area-desc';
        expect(context.sortProposalDataset(dataset).map(row => row.metrics.area)).toEqual([300, 100, null, NaN]);
        expect(dataset[0].metrics.area).toBeNull();
    });
});
