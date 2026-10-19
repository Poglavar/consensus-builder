// Housekeeping over the local proposal store: delete the experiments, rename the hashed titles.
//
// The store is IndexedDB. Anything not uploaded exists in exactly one browser, so a delete here has
// no undo and "I meant the other city" is unrecoverable. That shapes every test below: the delete
// must default to telling you what it WOULD do, and it must not remove a single record unless a
// backup was written in the same call.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');

let maintenance;
let saved;
let removed;
let renamed;
let downloads;
let batches;

const square = (lng, lat, side = 0.0005) => ({
    type: 'Polygon',
    coordinates: [[[lng, lat], [lng + side, lat], [lng + side, lat + side], [lng, lat + side], [lng, lat]]]
});

function proposal(id, { title, applied = false, city = 'sibenik', geometry = null } = {}) {
    return {
        proposalId: id,
        city,
        title: title || `Block ${id}`,
        applied,
        geometry: geometry ? { buildings: [geometry] } : undefined
    };
}

function install(proposals) {
    globalThis.turf = turf;
    globalThis.__parcelArrangement = require('../../frontend/js/proposals/parcel-arrangement.js');
    // Modelled on the real store, because the bug this file now guards was a mismatch with it:
    // removeProposal returns the removed RECORD or null (never a boolean), the list it deletes from
    // is live, and beginBatch/endBatch exist so a bulk run persists once.
    const live = proposals.slice();
    globalThis.proposalStorage = {
        beginBatch: () => { batches.push('begin'); },
        endBatch: () => { batches.push('end'); },
        getAllProposals: () => live.slice(),
        removeProposal: (id) => {
            const index = live.findIndex(p => String(p.proposalId) === String(id));
            if (index < 0) return null;                 // unresolvable id — exactly what bit us
            removed.push(id);
            return live.splice(index, 1)[0];
        },
        setProposalName: (id, name) => { renamed.push({ id, name }); return true; }
    };
    globalThis.CityConfigManager = { getCurrentCityId: () => 'sibenik' };
    globalThis.isProposalCurrentlyApplied = (p) => !!p.applied;
    globalThis.Blob = globalThis.Blob || class { constructor(parts) { this.parts = parts; } };
    globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => { } };
    globalThis.document = {
        createElement: () => ({ click: () => downloads.push('clicked'), style: {} }),
        body: { appendChild: () => { }, removeChild: () => { } }
    };
    globalThis.window = globalThis;
    delete require.cache[require.resolve('../../frontend/js/proposals/maintenance.js')];
    maintenance = require('../../frontend/js/proposals/maintenance.js');
}

beforeEach(() => {
    saved = { document: globalThis.document, window: globalThis.window, turf: globalThis.turf };
    removed = []; renamed = []; downloads = []; batches = [];
    vi.spyOn(console, 'warn').mockImplementation(() => { });
    vi.spyOn(console, 'log').mockImplementation(() => { });
    vi.spyOn(console, 'table').mockImplementation(() => { });
});

afterEach(() => {
    globalThis.document = saved.document; globalThis.window = saved.window;
    vi.restoreAllMocks();
});

describe('deleting the experiments', () => {
    const mixed = () => [
        proposal('p-1', { applied: true }),
        proposal('p-2', { applied: false }),
        proposal('p-3', { applied: false }),
        proposal('p-4', { applied: true, city: 'zagreb' }),
        proposal('p-5', { applied: false, city: 'zagreb' })
    ];

    it('deletes NOTHING by default — it reports what it would do', () => {
        install(mixed());
        const result = maintenance.deleteUnappliedProposals();
        expect(result.wouldDelete).toBe(2);
        expect(result.deleted).toBe(0);
        expect(removed).toEqual([]);
    });

    it('takes only the unapplied, and only from the city asked for', () => {
        install(mixed());
        maintenance.deleteUnappliedProposals({ apply: true });
        // p-1/p-4 applied, p-5 is another city.
        expect(removed.sort()).toEqual(['p-2', 'p-3']);
    });

    it('writes the backup BEFORE removing anything', () => {
        install(mixed());
        maintenance.deleteUnappliedProposals({ apply: true });
        expect(downloads.length, 'no backup was downloaded').toBe(1);
    });

    it('removes NOTHING when the backup could not be written', () => {
        install(mixed());
        // The one hard rule: no backup, no delete.
        globalThis.document.createElement = () => { throw new Error('no DOM'); };
        vi.spyOn(console, 'error').mockImplementation(() => { });
        const result = maintenance.deleteUnappliedProposals({ apply: true });
        expect(result).toBeNull();
        expect(removed).toEqual([]);
    });

    it('says so and stops when there is nothing unapplied', () => {
        install([proposal('p-1', { applied: true })]);
        expect(maintenance.deleteUnappliedProposals({ apply: true }).deleted).toBe(0);
        expect(downloads).toEqual([]);
    });
});

describe('renaming the hashed titles', () => {
    const hashed = () => [
        proposal('p-1', { title: 'Block HR-330264-685/1#p1ggd3r1', geometry: square(15.87, 43.75) }),
        proposal('p-2', { title: 'Block HR-329924-2337/2#p16svn9v', geometry: square(15.88, 43.76) }),
        proposal('p-3', { title: 'Block 4237-K7QM', geometry: square(15.89, 43.77) })
    ];

    it('recognises a hashed name and leaves a clean one alone', () => {
        install(hashed());
        expect(maintenance.isHashedName('Block HR-330264-685/1#p1ggd3r1')).toBe(true);
        expect(maintenance.isHashedName('Block 4237-K7QM')).toBe(false);
        expect(maintenance.isHashedName('Detached-houses 1008-1833')).toBe(false);
    });

    it('renames nothing by default', () => {
        install(hashed());
        expect(maintenance.renameHashedProposals().renamed).toBe(0);
        expect(renamed).toEqual([]);
    });

    it('renames only the hashed ones, to <Word> <area>-<CODE>', () => {
        install(hashed());
        maintenance.renameHashedProposals({ apply: true });
        expect(renamed).toHaveLength(2);
        renamed.forEach(entry => expect(entry.name).toMatch(/^Block \d+-[2-9A-HJ-NP-Z]{4}$/));
    });

    it('keeps the leading word, so a Park does not become a Block', () => {
        install([proposal('p-9', { title: 'Park HR-330264-574#pabcde', geometry: square(15.87, 43.75) })]);
        maintenance.renameHashedProposals({ apply: true });
        expect(renamed[0].name.startsWith('Park ')).toBe(true);
    });

    it('gives DIFFERENT shapes different codes — the half that was never asserted', () => {
        // Shipped naming three unrelated blocks …-FAXU. The fingerprint rounded coordinates to two
        // decimals, and two decimals of a DEGREE is ~1.1 km: every block in a neighbourhood hashed
        // to the same string, so the code addressed the kilometre square rather than the outline.
        // The same-shape-same-code test below passed throughout, because it can only ever see the
        // half of the property that was still true.
        install([]);
        const codes = [
            [15.8700, 43.7500, 0.0006],
            [15.8712, 43.7503, 0.0009],
            [15.8735, 43.7511, 0.0004],
            [15.8700, 43.7500, 0.0007]      // same corner, different size
        ].map(([lng, lat, side]) => {
            const name = maintenance.nameFor(proposal('x', { title: 'Block A#pzzzzz', geometry: square(lng, lat, side) }));
            return String(name).split('-').pop();
        });
        expect(new Set(codes).size, `codes collided: ${codes.join(', ')}`).toBe(codes.length);
    });

    it('gives the same shape the same code — that is what makes it an address', () => {
        install([proposal('a', { title: 'Block X#paaaaa', geometry: square(15.87, 43.75) })]);
        const first = maintenance.nameFor(proposal('a', { title: 'Block X#paaaaa', geometry: square(15.87, 43.75) }));
        const again = maintenance.nameFor(proposal('b', { title: 'Block Y#pbbbbb', geometry: square(15.87, 43.75) }));
        expect(first).toBe(again);
    });

    it('SKIPS a proposal with no geometry rather than inventing a name', () => {
        install([proposal('p-x', { title: 'Block HR-1-1#pzzzzz' })]);
        const result = maintenance.renameHashedProposals({ apply: true });
        expect(result.renamed).toBe(0);
        expect(result.skipped).toBe(1);
        expect(renamed).toEqual([]);
    });

    it('does not hand two proposals the same name', () => {
        // Same shape twice: the code collides by design, so the second gets a suffix.
        install([
            proposal('p-1', { title: 'Block A#paaaaa', geometry: square(15.87, 43.75) }),
            proposal('p-2', { title: 'Block B#pbbbbb', geometry: square(15.87, 43.75) })
        ]);
        maintenance.renameHashedProposals({ apply: true });
        expect(new Set(renamed.map(r => r.name)).size).toBe(2);
    });
});

describe('the report', () => {
    it('counts what is there before anything is touched', () => {
        install([
            proposal('p-1', { applied: true }),
            proposal('p-2', { applied: false }),
            proposal('p-3', { applied: false, title: 'Block HR-1-1#pabcde' })
        ]);
        const report = maintenance.proposalReport();
        expect(report).toMatchObject({ total: 3, applied: 1, notApplied: 2, hashedNames: 1 });
    });
});

describe('the delete reports the truth, not its own tally', () => {
    it('counts what is LEFT, so a resolve failure cannot read as success', () => {
        install([
            proposal('p-1', { applied: false }),
            proposal('p-2', { applied: false }),
            proposal('p-3', { applied: false })
        ]);
        // Two of the three cannot be resolved — the shape of the run that reported "30 deleted".
        const realRemove = globalThis.proposalStorage.removeProposal;
        globalThis.proposalStorage.removeProposal = (id) => (String(id) === 'p-1' ? realRemove(id) : null);

        const result = maintenance.deleteUnappliedProposals({ apply: true });
        expect(result.deleted).toBe(1);
        expect(result.attempted).toBe(3);
        expect(result.refused).toBe(2);
    });

    it('persists once for the whole run rather than once per record', () => {
        install([proposal('p-1', { applied: false }), proposal('p-2', { applied: false })]);
        maintenance.deleteUnappliedProposals({ apply: true });
        expect(batches).toEqual(['begin', 'end']);
    });

    it('closes the batch even when a removal throws', () => {
        install([proposal('p-1', { applied: false })]);
        globalThis.proposalStorage.removeProposal = () => { throw new Error('boom'); };
        maintenance.deleteUnappliedProposals({ apply: true });
        // An unclosed batch would suspend every later save in the session, silently.
        expect(batches).toEqual(['begin', 'end']);
    });
});

// The first rename pass wrote codes from a fingerprint that rounded DEGREES to two decimals, so
// unrelated blocks all came out …-FAXU. Those names are not wrong — the area still separates them —
// but the code does not stand for the outline, which is the only reason a code is there.
//
// Re-coding them means touching names that already look fine, so what it must NOT touch is as
// important as what it must.
describe('re-coding the stale names', () => {
    const withName = (id, title, lng, lat, side) => ({
        proposalId: id, city: 'sibenik', title,
        geometry: { buildings: [square(lng, lat, side)] }
    });

    const mixed = () => [
        withName('a', 'Block 3223-P7FA', 15.8700, 43.7500, 0.0006),
        withName('b', 'Block 7251-P7FA', 15.8712, 43.7503, 0.0009),
        withName('c', 'Block 1432-P7FA', 15.8735, 43.7511, 0.0004),
        // The old timestamp convention, which the user asked to keep. 0 and 1 are not in the code
        // alphabet, so an HHMM cannot be mistaken for a code.
        withName('d', 'Block 1108-0126', 15.8750, 43.7520, 0.0005),
        withName('e', 'Detached-houses 1008-1833', 15.8760, 43.7530, 0.0005)
    ];

    it('changes nothing by default', () => {
        install(mixed());
        expect(maintenance.regenerateProposalNames().renamed).toBe(0);
        expect(renamed).toEqual([]);
    });

    it('re-codes the collided names and gives each a distinct code', () => {
        install(mixed());
        const result = maintenance.regenerateProposalNames({ apply: true });
        expect(result.renamed).toBe(3);
        const codes = renamed.map(entry => entry.name.split('-').pop());
        expect(new Set(codes).size, `still colliding: ${codes.join(', ')}`).toBe(3);
    });

    it('keeps the AREA — only the code was ever wrong', () => {
        install(mixed());
        maintenance.regenerateProposalNames({ apply: true });
        const areas = renamed.map(entry => entry.name.match(/ (\d+)-/)[1]).sort();
        expect(areas).toEqual(['1432', '3223', '7251']);
    });

    it('leaves the timestamp names alone — those were asked for', () => {
        install(mixed());
        maintenance.regenerateProposalNames({ apply: true });
        expect(renamed.map(entry => entry.id).sort()).toEqual(['a', 'b', 'c']);
    });

    it('is a no-op on a second run, so it cannot churn names every time it is called', () => {
        install(mixed());
        maintenance.regenerateProposalNames({ apply: true });
        // The fake store does not write back, so re-point it at the names it just produced.
        const settled = mixed().map(p => {
            const change = renamed.find(entry => entry.id === p.proposalId);
            return change ? { ...p, title: change.name } : p;
        });
        install(settled);
        expect(maintenance.regenerateProposalNames({ apply: true }).renamed).toBe(0);
    });

    it('holds back a name whose AREA also disagrees, until asked', () => {
        // A code-shaped suffix in front of something that is not the area — or geometry that moved.
        // Rewriting those silently would be renaming on a guess.
        install([withName('z', 'Block 9999-ABCD', 15.87, 43.75, 0.0006)]);
        const held = maintenance.regenerateProposalNames({ apply: true });
        expect(held.renamed).toBe(0);
        expect(held.areaMoved).toBe(1);

        install([withName('z', 'Block 9999-ABCD', 15.87, 43.75, 0.0006)]);
        expect(maintenance.regenerateProposalNames({ apply: true, includeMovedArea: true }).renamed).toBe(1);
    });
});
