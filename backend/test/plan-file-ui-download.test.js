// Download a plan or a design as a file from any surface: PlanFileUI.plan and PlanFileUI.design offer
// the editable plan, GeoJSON and CityJSON downloads only (no import), named after the record's title.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const FileUI = require('../../frontend/js/plan-file-ui.js');
const FileDownload = require('../../frontend/js/ui/file-download.js');
const DesignFileExports = require('../../frontend/js/design-file-exports.js');

class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.textContent = ''; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    prepend(...children) { this.children.unshift(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    remove() {}
    click() { this.clicked = true; return this.listeners.click?.(); }
}

function browser() {
    const modals = [], downloads = [];
    const win = {
        document: { body: new Element('body'), createElement: tag => {
            const element = new Element(tag);
            if (tag === 'a') element.click = () => downloads.push({ name: element.download, href: element.href });
            return element;
        } },
        URL: { createObjectURL: blob => { downloads.blob = blob; return 'blob:x'; }, revokeObjectURL() {} }, Blob,
        setTimeout: callback => callback(), requestAnimationFrame: callback => queueMicrotask(callback),
        getProposalI18nHelper: () => (_key, fallback) => fallback, showStyledAlert: vi.fn(),
        BusyControl: { track: (_button, work) => work() },
        showSimpleShareModal: options => { modals.push(options); return { close() {} }; },
        PlanFile: { create: vi.fn(async (records, options) => ({ records, options })), stringify: file => JSON.stringify(file), geojsonRecords: () => ({ type: 'FeatureCollection', features: [] }) },
        PlanWorkspace: { resolve: vi.fn(async plan => ({ ...plan, designs: [{ cid: 'bafy-d' }], designSources: {} })) },
        PlanComposition: { localRecords: vi.fn(row => row.designs.map(member => ({ proposalId: `plan-member-${member.cid}` }))) },
        DesignSync: { apiBase: () => 'https://api.example' },
        MapShare: { capture: () => ({ at: '45.8,15.9,18' }) }, FileDownload, DesignFileExports,
        proj4: () => null,
        // The CityJSON exporter loads on first use, as in the page.
        ensureOptionalTool: vi.fn(async group => {
            if (group === 'cityJson') win.CityJsonExport = { fromPlanFile: vi.fn(file => ({ type: 'CityJSON', version: '2.0', title: file.options.title })) };
        })
    };
    return { win, modals, downloads };
}
const actionsOf = modal => modal.body.children.filter(child => child.tagName === 'button').map(child => child.dataset.planFileAction);
const buttonOf = (modal, action) => modal.body.children.find(child => child.dataset.planFileAction === action);

describe('PlanFileUI downloads from any surface', () => {
    it('downloads a design as a one-design file named after its title, with no import offered', async () => {
        const { win, modals, downloads } = browser();
        const ui = FileUI.browser(win);
        ui.design({ proposalId: 'p1', title: 'Riverside Blocks č' });
        expect(modals[0].title).toBe('Download design');
        expect(actionsOf(modals[0])).toEqual(['json', 'geojson', 'cityjson']);
        await buttonOf(modals[0], 'json').click();
        expect(win.PlanFile.create).toHaveBeenCalledWith([{ proposalId: 'p1', title: 'Riverside Blocks č' }], expect.objectContaining({ title: 'Riverside Blocks č' }));
        expect(downloads[0].name).toBe('riverside-blocks-c.ugt.json');
        await buttonOf(modals[0], 'geojson').click();
        expect(downloads[1].name).toBe('riverside-blocks-c.geojson');
        // CityJSON is made from the same plan file the editable download is.
        expect(win.CityJsonExport).toBeUndefined();
        await buttonOf(modals[0], 'cityjson').click();
        expect(win.ensureOptionalTool).toHaveBeenCalledWith('cityJson');
        expect(downloads[2].name).toBe('riverside-blocks-c.city.json');
        expect(win.CityJsonExport.fromPlanFile).toHaveBeenCalledWith(expect.objectContaining({ records: [{ proposalId: 'p1', title: 'Riverside Blocks č' }] }), { proj4: win.proj4 });
        expect(JSON.parse(await downloads.blob.text())).toEqual({ type: 'CityJSON', version: '2.0', title: 'Riverside Blocks č' });
    });

    it('downloads a plan revision with its members, view and schedule', async () => {
        const { win, modals, downloads } = browser();
        const ui = FileUI.browser(win);
        const plan = { cid: 'bafy-plan', content: { title: 'East quarter', view: { at: '45.8,15.9,17' }, schedule: { 'bafy-d': { start: 1 } } } };
        const members = [{ proposalId: 'm1' }];
        await ui.plan(plan, members);
        expect(win.PlanWorkspace.resolve).toHaveBeenCalledWith(plan, members);
        expect(modals[0].title).toBe('Download plan');
        expect(actionsOf(modals[0])).toEqual(['json', 'geojson', 'cityjson']);
        await buttonOf(modals[0], 'json').click();
        expect(win.PlanFile.create).toHaveBeenCalledWith([{ proposalId: 'plan-member-bafy-d' }],
            expect.objectContaining({ title: 'East quarter', view: { at: '45.8,15.9,17' }, schedule: { 'bafy-d': { start: 1 } } }));
        expect(downloads[0].name).toBe('east-quarter.ugt.json');
    });

    it('names an untitled download plan', async () => {
        const { win, modals, downloads } = browser();
        FileUI.browser(win).design({ proposalId: 'p1', title: '—' });
        await buttonOf(modals[0], 'geojson').click();
        expect(downloads[0].name).toBe('plan.geojson');
    });
});
