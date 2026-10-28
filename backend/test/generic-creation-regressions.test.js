import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { validateProposalRecipient } = require('../../frontend/js/proposal-drafts.js');
const siteDraft = require('../../frontend/js/proposals/site-draft.js');
const turf = require('@turf/turf');
const source = path => readFileSync(new URL(`../../frontend/js/${path}`, import.meta.url), 'utf8');

describe('generic creation', () => {
    it('requires a nonblank specific third-party recipient while allowing anyone and other ownership choices', () => {
        for (const recipientAddress of ['', '   ', null]) {
            expect(validateProposalRecipient({ ownership: 'third-party', recipientScope: 'specific', recipientAddress })).toBe(false);
        }
        expect(validateProposalRecipient({ ownership: 'third-party', recipientScope: 'specific', recipientAddress: '  Alice  ' })).toBe(true);
        expect(validateProposalRecipient({ ownership: 'third-party', recipientScope: 'any' })).toBe(true);
        expect(validateProposalRecipient({ ownership: 'to-me', recipientScope: 'specific' })).toBe(true);
    });

    it('builds the site from every selected live parcel and refuses incomplete land', () => {
        const code = source('proposals/create.js');
        const end = code.indexOf('// The city a proposal belongs to');
        const context = vm.createContext({});
        vm.runInContext(code.slice(0, end), context);
        const a = turf.polygon([[[15,45],[15.001,45],[15.001,45.001],[15,45.001],[15,45]]]);
        const b = turf.polygon([[[15.001,45],[15.002,45],[15.002,45.001],[15.001,45.001],[15.001,45]]]);
        const result = context.buildingSiteFromSelection(['a', 'b'], id => ({ a, b })[id], features => siteDraft.siteFromFeatures(features, { turf }));
        expect(turf.area(turf.feature(result))).toBeCloseTo(turf.area(a) + turf.area(b), 3);
        expect(() => context.buildingSiteFromSelection(['a', 'missing'], id => ({ a })[id], vi.fn())).toThrow(/selected land/);
    });

    it('blocks the generic row launcher on one parcel and opens it for two', async () => {
        const code = source('proposals/list-ui.js');
        const start = code.indexOf('async function launchRowHouseToolForSelection()');
        const end = code.indexOf('async function launchParcelBasedToolForSelection()', start);
        let ids = ['a'];
        const open = vi.fn().mockResolvedValue(true), status = vi.fn();
        const context = vm.createContext({ getCurrentParcelSelectionContext: () => ({ ids }), updateStatus: status,
            getProposalI18nHelper: () => (_key, fallback) => fallback,
            shouldStopFreshProposalForWholeBlock: async () => false, openRowHouseForParcels: open,
            formatParcelSelectionLabel: () => 'Selection' });
        vm.runInContext(code.slice(start, end), context);
        expect(await context.launchRowHouseToolForSelection()).toBe(false);
        expect(status).toHaveBeenCalledWith(expect.stringContaining('at least two parcels'));
        expect(open).not.toHaveBeenCalled();
        ids = ['a', 'b'];
        expect(await context.launchRowHouseToolForSelection()).toBe(true);
        expect(open).toHaveBeenCalledOnce();
    });
});
