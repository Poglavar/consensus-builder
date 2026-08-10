// Authoring must refuse exactly what apply refuses — no more.
//
// A readjustment may stand on any ground that is not already taken, remainders included: forming
// blocks with roads and then redividing them is the reason to draw roads first. The apply gate was
// relaxed to that rule, but the MODAL still refused any derived id, so the tool blocked work the
// model allows — and the refusal cost the draft too, because failing to reopen the design tool used
// to delete it.
//
// Both halves are pinned here. A gate that is stricter than apply is a bug of the same kind as one
// that is looser: it just fails earlier and looks like a rule.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const reparcellization = read('../../frontend/js/reparcellization.js');
const applyParcels = read('../../frontend/js/proposals/apply/parcels.js');
const editorShell = read('../../frontend/js/proposal-editor-shell.js');
const dictOf = locale => JSON.parse(read(`../../frontend/i18n/${locale}.json`));
const locales = ['en', 'hr', 'sr', 'es'];

// The authoring gate, lifted so it can be run against real selections.
function loadAuthoringTest() {
    const start = reparcellization.indexOf('            const takenInputs = ');
    expect(start, 'authoring gate not found').toBeGreaterThan(-1);
    const end = reparcellization.indexOf('            if (takenInputs.length) {', start);
    const body = reparcellization.slice(start, end);
    // eslint-disable-next-line no-new-func
    return new Function('selection', `${body} return takenInputs;`);
}

const layer = properties => ({ feature: { properties } });

describe('what authoring refuses', () => {
    const takenInputs = loadAuthoringTest();

    it('allows a remainder a road left behind — the block workflow', () => {
        const selection = {
            layers: [
                layer({ parcelId: 'HR-1-100#p1a2b3c', formedByProposalIds: [] }),
                layer({ parcelId: 'HR-1-101#p9z8y7x', formedByProposalIds: [] })
            ]
        };
        expect(takenInputs(selection)).toEqual([]);
    });

    it('allows a plain cadastral parcel', () => {
        expect(takenInputs({ layers: [layer({ parcelId: 'HR-1-100' })] })).toEqual([]);
    });

    it('refuses a corridor piece — that ground belongs to the road', () => {
        const selection = { layers: [layer({ parcelId: 'HR-1-100#r4d5e6f', isCorridor: true, formedByProposalIds: ['p-road'] })] };
        expect(takenInputs(selection)).toEqual(['HR-1-100#r4d5e6f']);
    });

    it('refuses a track piece too', () => {
        const selection = { layers: [layer({ parcelId: 'HR-1-100#r1', isTrack: true })] };
        expect(takenInputs(selection)).toHaveLength(1);
    });

    it('refuses anything with a taker, flagged or not', () => {
        const selection = { layers: [layer({ parcelId: 'HR-1-100#r2', formedByProposalIds: ['p-road'] })] };
        expect(takenInputs(selection)).toHaveLength(1);
    });

    it('reports only the offending pieces, not the whole selection', () => {
        const selection = {
            layers: [
                layer({ parcelId: 'HR-1-100#pfree', formedByProposalIds: [] }),
                layer({ parcelId: 'HR-1-100#rtaken', isCorridor: true }),
                layer({ parcelId: 'HR-1-101' })
            ]
        };
        expect(takenInputs(selection)).toEqual(['HR-1-100#rtaken']);
    });

    it('says nothing about an empty selection', () => {
        expect(takenInputs({ layers: [] })).toEqual([]);
        expect(takenInputs({})).toEqual([]);
    });
});

describe('authoring and apply ask the same question', () => {
    it('both test taken-ness, not derived-ness', () => {
        // The old rule keyed on the id containing '#'. Every block a road forms is made of those,
        // so that test blocked the main use of the feature.
        expect(reparcellization).not.toMatch(/derivedInputs/);
        expect(applyParcels).not.toMatch(/readjustment-derived-ground/);
        [reparcellization, applyParcels].forEach(source => {
            expect(source).toMatch(/isCorridor === true/);
            expect(source).toMatch(/formedByProposalIds/);
        });
    });

    it('the apply gate is the authoritative one and still exists', () => {
        expect(applyParcels).toMatch(/readjustment-taken-ground/);
    });

    it('neither carries the whole-parcel tessellation rule any more', () => {
        expect(applyParcels).not.toMatch(/readjustment-partial-parcels/);
    });
});

describe('a refusal does not cost the work', () => {
    const keepAsDraft = (() => {
        const start = editorShell.indexOf('const keepAsDraft =');
        expect(start, 'keepAsDraft not found').toBeGreaterThan(-1);
        // Search for the end FROM the start — the same statement appears earlier in the file, and
        // indexOf from zero found that one, producing an empty slice that matched nothing.
        return editorShell.slice(start, editorShell.indexOf('draft = store.validateDraft(draftId);', start));
    })();

    it('keeps the draft when the design tool will not reopen', () => {
        expect(keepAsDraft).not.toMatch(/deleteDraft/);
    });

    it('says so rather than failing silently', () => {
        expect(keepAsDraft).toMatch(/proposalDrafts\.keptUnopened/);
        expect(keepAsDraft).toMatch(/showEphemeralMessage/);
    });
});

describe('every locale can explain both', () => {
    it.each(locales)('%s has the taken-ground and kept-draft messages', locale => {
        const dict = dictOf(locale);
        expect(dict.reparcellization.modal.takenGroundBlocked, `${locale} missing takenGroundBlocked`).toBeTruthy();
        expect(dict.proposalDrafts.keptUnopened, `${locale} missing keptUnopened`).toBeTruthy();
        // The rule it used to state is gone; leaving the string invites the rule back.
        expect(dict.reparcellization.modal.derivedGroundBlocked).toBeUndefined();
    });
});
