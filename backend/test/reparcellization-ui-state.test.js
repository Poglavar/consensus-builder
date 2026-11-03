// Unit and wiring tests for the parcel-layout editor's UI-state helpers: draw shortcuts, a layout's
// input parcels, and owner labels (used by the ownership panel). The wiring is checked on a real
// editor opened in helpers/parcel-layout-env.js.
import { describe, expect, it, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { makeEditor, box } from './helpers/parcel-layout-env.js';

const require = createRequire(import.meta.url);
const {
    resolveDrawShortcut,
    resolveOwnerDisplayName,
    resolveOwnerLabel,
    genericOwnerKind,
    readjustmentInputFeatures
} = require('../../frontend/js/reparcellization-ui-state.js');
const styles = readFileSync(new URL('../../frontend/css/on-map-reparcellization.css', import.meta.url), 'utf8');
const locale = code => JSON.parse(readFileSync(new URL(`../../frontend/i18n/${code}.json`, import.meta.url), 'utf8'));

describe('saved layout inputs', () => {
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

describe('parcel-layout UI state', () => {
    it('uses F (or Enter), C, and U for finish, cancel, and undo while drawing', () => {
        expect(resolveDrawShortcut({ active: true, key: 'f' })).toBe('finish');
        expect(resolveDrawShortcut({ active: true, key: 'C' })).toBe('cancel');
        expect(resolveDrawShortcut({ active: true, key: 'u' })).toBe('undo');
        expect(resolveDrawShortcut({ active: true, key: 'Enter' })).toBe('finish');
        expect(resolveDrawShortcut({ active: true, key: 'Enter', editable: true })).toBeNull();
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

    it('localizes known generic owner labels while retaining source-stable identities', () => {
        const samples = {
            en: { private: 'Private owner', public: 'Public land' },
            es: { private: 'Propietario privado', public: 'Suelo público' },
            hr: { private: 'Privatni vlasnik', public: 'Javno zemljište' },
            sr: { private: 'Privatni vlasnik', public: 'Javno zemljište' }
        };
        for (const [language, expected] of Object.entries(samples)) {
            const dictionary = locale(language);
            const translate = (key, fallback) => key.split('.').reduce((value, part) => value?.[part], dictionary) || fallback;
            const privateOwner = resolveOwnerLabel('Privatni vlasnik', 'Owner of parcel', translate);
            const publicLand = resolveOwnerLabel('Public land', 'Owner of parcel', translate);
            expect(privateOwner.displayName).toBe(expected.private);
            expect(publicLand.displayName).toBe(expected.public);
            expect(privateOwner.identityName).toBe('Privatni vlasnik');
            expect(publicLand.identityName).toBe('Public land');
        }
        expect(resolveOwnerLabel('REPUBLIKA HRVATSKA', 'Owner', (_key, fallback) => fallback))
            .toEqual({ displayName: 'REPUBLIKA HRVATSKA', identityName: 'REPUBLIKA HRVATSKA' });
        expect(genericOwnerKind('Republika Hrvatska')).toBeNull();
    });

    // A real editor on one 40 × 50 m parcel, opened and torn down per test.
    let env = null;
    afterEach(() => { env?.dispose(); env = null; });
    async function openEditor(beforeOpen = () => {}) {
        env = makeEditor({
            parcels: [{ id: 'P1', geometry: box(0, 0, 40, 50) }],
            selection: { ids: ['P1'] }
        });
        beforeOpen();
        expect(await env.editor.openParcelLayoutEditor()).toBe(true);
        return env;
    }

    it('wires the draw shortcuts into icon-free shortcut-labelled controls', async () => {
        const w = await openEditor();
        expect(w.$('[data-reparcel-undo]').textContent).toBe('Undo point (U)');
        expect(w.$('[data-reparcel-finish]').textContent).toBe('Finish plot (F)');
        expect(w.$('[data-reparcel-cancel-draw]').textContent).toBe('Cancel (C)');
        // The keys reach the draw tools through resolveDrawShortcut: C cancels a stroke under way.
        w.$('[data-reparcel-draw]').click();
        expect(w.state.drawing.active).toBe(true);
        w.key('c');
        expect(w.state.drawing.active).toBe(false);
    });

    it('uses the shared map editor session and never destroys the app map on close', async () => {
        const w = await openEditor(() => {
            globalThis.L.tileLayer = () => { throw new Error('the editor added a tile layer'); };
            globalThis.L.map = () => { throw new Error('the editor made its own Leaflet map'); };
        });
        const [options] = globalThis.OnMapEditor.open.calls[0];
        expect(options).toMatchObject({ owner: 'parcel-layout', modes: ['2d'], handleEscape: false });
        const session = w.session();
        expect(w.state.map).toBe(session.map);
        expect(w.state.map).toBe(globalThis.map);
        const removed = [];
        globalThis.map.remove = () => removed.push('map');
        w.$('[data-reparcel-cancel]').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(session.close.calls).toHaveLength(1);
        expect(removed).toEqual([]);
        // The overlays it added are gone from the map; the map itself stays.
        expect(globalThis.map.getLayers().filter(layer => layer.kind === 'geojson')).toEqual([]);
    });

    it('keeps one editor panel with three tabs and preserves layout history across them', async () => {
        const w = await openEditor();
        const [options] = globalThis.OnMapEditor.open.calls[0];
        expect(options.tools).toBeUndefined();
        expect(options.reserveToolsSpace).not.toBe(true);
        const editing = w.$('#reparcel-panel-editing');
        const count = w.$('[data-parcel-layout-count-field]');
        expect(editing.contains(count)).toBe(true);
        expect(editing.contains(w.$('.reparcel-file-tools'))).toBe(true);
        expect(editing.contains(w.$('.reparcel-persistent-controls'))).toBe(true);
        expect(w.state.plotsTab).toBe('editing');
        expect(editing.hidden).toBe(false);
        expect(w.state.newPlotsListEl.hidden).toBe(true);
        expect(w.state.oldPlotsListEl.hidden).toBe(true);
        await w.editor.setPlotCount(3);
        const geometry = JSON.stringify(w.state.slices), history = w.state.historyCtl.depth();
        for (const tab of ['new', 'editing', 'old', 'editing']) {
            w.editor.setPlotsTab(tab);
            expect(w.state.plotsTab).toBe(tab);
            expect(editing.hidden).toBe(tab !== 'editing');
            expect(w.state.newPlotsListEl.hidden).toBe(tab !== 'new');
            expect(w.state.oldPlotsListEl.hidden).toBe(tab !== 'old');
            expect(JSON.stringify(w.state.slices)).toBe(geometry);
            expect(w.state.historyCtl.depth()).toBe(history);
        }
        expect(w.state.nodeEdit.active).toBe(true);
        expect(w.$('[data-reparcel-undo-edit]').textContent).toContain('Undo');
        expect(w.$('[data-reparcel-redo-edit]').textContent).toContain('Redo');
        expect(styles).not.toContain('.reparcel-tools-map');
    });

    it('reports the live tool context for chat and clears it when the editor closes', async () => {
        const w = await openEditor();
        expect(w.editor.getEditorContext()).toEqual({ kind: 'parcel-layout', tab: 'editing',
            algorithm: 'equal', plotCount: 2, dirty: false, drawing: 'nodes' });
        await w.editor.setPlotCount(3);
        w.editor.startDraw('line');
        expect(w.editor.getEditorContext()).toMatchObject({ plotCount: 3, dirty: true, drawing: 'line' });
        w.editor.setPlotsTab('new');
        expect(w.editor.getEditorContext()).toMatchObject({ tab: 'new', drawing: 'line' });
        w.editor.closeModal({ skipPersist: true, discard: true });
        expect(w.editor.getEditorContext()).toBeNull();
    });
});
