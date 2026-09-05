// Unit and wiring tests for land-readjustment draw shortcuts and the distinction between an
// unassigned output plot and an unnamed original owner in the accounting ledger.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
    resolveDrawShortcut,
    resolveOwnerDisplayName,
    normalizePlotOwners,
    plotIsAssigned,
    readjustmentInputFeatures
} = require('../../frontend/js/reparcellization-ui-state.js');
const source = readFileSync(new URL('../../frontend/js/reparcellization.js', import.meta.url), 'utf8');

describe('saved readjustment inputs', () => {
    const original = { type: 'Feature', properties: { parcelId: 'HR-335550-1791/69', owner: 'Original owner' } };
    const replacement = { type: 'Feature', properties: { parcelId: 'HR-335550-1791/69#plan-1', owner: 'New owner' } };
    const sources = { cadastre: new Map([[original.properties.parcelId, original]]), live: new Map([[replacement.properties.parcelId, replacement]]) };

    it('recovers original owner facts for a saved plan after the live root was consumed', () => {
        expect(readjustmentInputFeatures({ ids: [original.properties.parcelId], source: 'cadastre' }, sources))
            .toEqual({ features: [original], missing: [] });
    });

    it('keeps new selections on their live pieces and does not resurrect consumed originals', () => {
        expect(readjustmentInputFeatures({ ids: [replacement.properties.parcelId] }, sources))
            .toEqual({ features: [replacement], missing: [] });
        expect(readjustmentInputFeatures({ ids: [original.properties.parcelId] }, sources))
            .toEqual({ features: [], missing: [original.properties.parcelId] });
    });
});

describe('land-readjustment UI state', () => {
    it('uses F, C, and U for finish, cancel, and undo while drawing', () => {
        expect(resolveDrawShortcut({ active: true, key: 'f' })).toBe('finish');
        expect(resolveDrawShortcut({ active: true, key: 'C' })).toBe('cancel');
        expect(resolveDrawShortcut({ active: true, key: 'u' })).toBe('undo');
        expect(resolveDrawShortcut({ active: true, key: 'Enter' })).toBeNull();
        expect(resolveDrawShortcut({ active: true, key: 'Backspace' })).toBeNull();
    });

    it('does not steal shortcuts outside drawing or while typing', () => {
        expect(resolveDrawShortcut({ active: false, key: 'f' })).toBeNull();
        expect(resolveDrawShortcut({ active: true, key: 'f', editable: true })).toBeNull();
        expect(resolveDrawShortcut({ active: true, key: 'f', metaKey: true })).toBeNull();
        expect(resolveDrawShortcut({ active: true, key: 'f', repeat: true })).toBeNull();
    });

    it('reserves “Unassigned” for ownerless plots and preserves real owner names', () => {
        expect(resolveOwnerDisplayName('Unassigned', 'Owner of 123', ['Unassigned']))
            .toBe('Owner of 123');
        expect(resolveOwnerDisplayName('Nedodijeljeno', 'Vlasnik 123', ['Nedodijeljeno']))
            .toBe('Vlasnik 123');
        expect(resolveOwnerDisplayName('Ada Lovelace', 'Owner of 123', ['Unassigned']))
            .toBe('Ada Lovelace');
    });

    it('wires the pure decisions into icon-free shortcut-labelled controls and the owner ledger', () => {
        expect(source).toContain('data-reparcel-undo>${t(\'reparcellization.modal.drawUndo\', \'Undo point\')} (U)</button>');
        expect(source).toContain('data-reparcel-finish>${t(\'reparcellization.modal.drawFinish\', \'Finish plot\')} (F)</button>');
        expect(source).toContain('data-reparcel-cancel-draw>${t(\'reparcellization.modal.drawCancel\', \'Cancel\')} (C)</button>');
        expect(source).toContain('const action = resolveDrawShortcut({');
        expect(source).toContain('resolveOwnerDisplayName(slot.displayName,');
    });
});

// A plot's owner is stored twice — the singular ownerKey/displayName and owners[]. Reading only
// one of them is what disabled Done forever on an imported plan.
describe('plot owner normalisation', () => {
    it('reads an owners[] array as given', () => {
        const owners = normalizePlotOwners({
            ownerKey: 'a',
            owners: [{ ownerKey: 'a', displayName: 'Ada', share: 0.6 }, { ownerKey: 'b', displayName: 'Bo', share: 0.4 }]
        });
        expect(owners.map(o => o.ownerKey)).toEqual(['a', 'b']);
        expect(owners[0].share).toBeCloseTo(0.6);
    });

    it('derives the array from a lone ownerKey when owners[] is absent', () => {
        const owners = normalizePlotOwners({ ownerKey: 'is-1', displayName: 'Prometna površina IS-1', color: '#9aa0a6' });
        expect(owners).toEqual([{ ownerKey: 'is-1', displayName: 'Prometna površina IS-1', color: '#9aa0a6', share: 1 }]);
    });

    it('splits shares evenly when none are recorded', () => {
        const owners = normalizePlotOwners({ owners: [{ ownerKey: 'a' }, { ownerKey: 'b' }] });
        expect(owners.map(o => o.share)).toEqual([0.5, 0.5]);
    });

    it('treats a plot with no owner at all as unassigned', () => {
        expect(normalizePlotOwners({ displayName: 'Unassigned' })).toEqual([]);
        expect(normalizePlotOwners({ ownerKey: '', owners: [{ share: 1 }] })).toEqual([]);
        expect(plotIsAssigned({ displayName: 'Unassigned' })).toBe(false);
    });

    it('counts every plot of a saved plan that carries only ownerKey — the Borovje UPU shape', () => {
        // Verbatim field set of a stored UPU polygon: ownerKey present, owners absent.
        const savedPlan = [
            { ownerKey: 'is-1', displayName: 'Prometna površina IS-1', color: '#9aa0a6', percent: 13.43, area: 13851 },
            { ownerKey: 'r2-1', displayName: 'Rekreacija R2-1', color: '#5aa469', percent: 5.22, area: 5382 },
            { ownerKey: 'm1-11', displayName: 'Građevna čestica M1-11', color: '#e8a33d', percent: 5.02, area: 5177 }
        ];
        expect(savedPlan.every(plotIsAssigned)).toBe(true);
        expect(savedPlan.filter(p => !plotIsAssigned(p))).toHaveLength(0);
    });

    it('keeps public land assigned — it has a real owner key', () => {
        expect(plotIsAssigned({ ownerKey: '__public__', displayName: 'Public land' })).toBe(true);
    });
});
