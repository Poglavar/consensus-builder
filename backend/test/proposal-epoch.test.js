// Epoch buckets: čista logika vremenske crte (frontend/js/proposals/epoch.js,
// UMD — u nodeu izvozi samo čisti dio) i mapiranje epoch_year kroz serializer.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { serializeProposalRow } from '../proposals/serializer.js';

const require = createRequire(import.meta.url);
const epoch = require('../../frontend/js/proposals/epoch.js');

describe('parseEpochYear', () => {
    it('prihvaća cijele godine u rasponu, i kao string', () => {
        expect(epoch.parseEpochYear(2045)).toBe(2045);
        expect(epoch.parseEpochYear('2066')).toBe(2066);
        expect(epoch.parseEpochYear(2026)).toBe(2026);
        expect(epoch.parseEpochYear(2966)).toBe(2966);
    });

    it('sve krivo daje null, nikad broj', () => {
        expect(epoch.parseEpochYear(null)).toBe(null);
        expect(epoch.parseEpochYear(undefined)).toBe(null);
        expect(epoch.parseEpochYear('')).toBe(null);
        expect(epoch.parseEpochYear('kifla')).toBe(null);
        expect(epoch.parseEpochYear(2025)).toBe(null);   // ispod raspona
        expect(epoch.parseEpochYear(2967)).toBe(null);   // iznad raspona
        expect(epoch.parseEpochYear(2045.5)).toBe(null); // nije cijeli broj
        expect(epoch.parseEpochYear(0)).toBe(null);
    });
});

describe('distinctEpochs', () => {
    it('sortirane različite godine; bez epohe se preskače', () => {
        const lista = [
            { epochYear: 2055 }, { epochYear: 2035 }, { epochYear: 2055 },
            { epochYear: null }, {}, { epochYear: 'x' }
        ];
        expect(epoch.distinctEpochs(lista)).toEqual([2035, 2055]);
        expect(epoch.distinctEpochs([])).toEqual([]);
        expect(epoch.distinctEpochs(null)).toEqual([]);
    });
});

describe('kumulativna pripadnost i filtar liste', () => {
    const p35 = { epochYear: 2035 }, p55 = { epochYear: 2055 }, bez = {};

    it('bez epohe je uvijek unutra (postojeće stanje grada)', () => {
        expect(epoch.belongsCumulative(bez, 2035)).toBe(true);
        expect(epoch.belongsCumulative(p35, 2035)).toBe(true);
        expect(epoch.belongsCumulative(p55, 2035)).toBe(false);
        expect(epoch.belongsCumulative(p55, 2055)).toBe(true);
    });

    it('filterEntriesCumulative radi nad {proposal} zapisima; null godina = sve', () => {
        const entries = [{ proposal: p35 }, { proposal: p55 }, { proposal: bez }];
        expect(epoch.filterEntriesCumulative(entries, null)).toHaveLength(3);
        expect(epoch.filterEntriesCumulative(entries, 2035).map(e => e.proposal))
            .toEqual([p35, bez]);
        expect(epoch.filterEntriesCumulative(entries, 'nevaljalo')).toHaveLength(3);
    });
});

describe('epochDiff — što još primijeniti, što maknuti za odabranu godinu', () => {
    const prijedlozi = [
        { id: 'a', epochYear: 2035, applied: true },
        { id: 'b', epochYear: 2035, applied: false },   // pripada, a nije primijenjen
        { id: 'c', epochYear: 2055, applied: true },    // ne pripada, a primijenjen je
        { id: 'd', epochYear: 2055, applied: false },
        { id: 'e', applied: false }                     // bez epohe: pripada uvijek
    ];
    const isApplied = p => p.applied === true;

    it('2035: primijeni b i e, makni c', () => {
        const d = epoch.epochDiff(prijedlozi, 2035, isApplied);
        expect(d.toApply.map(p => p.id)).toEqual(['b', 'e']);
        expect(d.toUnapply.map(p => p.id)).toEqual(['c']);
    });

    it('bez godine nema razlike', () => {
        const d = epoch.epochDiff(prijedlozi, null, isApplied);
        expect(d.toApply).toEqual([]);
        expect(d.toUnapply).toEqual([]);
    });
});

describe('serializer: epoch_year → epochYear', () => {
    const osnovni = { proposal_id: 'p-1', type: 'road', proposal_data: {} };

    it('stupac iz baze pobjeđuje i pretvara se u broj', () => {
        const p = serializeProposalRow({ ...osnovni, epoch_year: '2045' });
        expect(p.epochYear).toBe(2045);
    });

    it('bez stupca: epochYear iz proposal_data, inače null', () => {
        const iz = serializeProposalRow({ ...osnovni, proposal_data: { epochYear: 2055 } });
        expect(iz.epochYear).toBe(2055);
        const prazan = serializeProposalRow(osnovni);
        expect(prazan.epochYear).toBe(null);
    });
});
