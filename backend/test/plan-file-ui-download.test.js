// Download a plan or a design as a file from any surface: PlanFileUI.plan and PlanFileUI.design offer
// the two downloads only (no import), named after the record's title.
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
        MapShare: { capture: () => ({ at: '45.8,15.9,18' }) }, FileDownload, DesignFileExports
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
        expect(actionsOf(modals[0])).toEqual(['json', 'geojson']);
        await buttonOf(modals[0], 'json').click();
        expect(win.PlanFile.create).toHaveBeenCalledWith([{ proposalId: 'p1', title: 'Riverside Blocks č' }], expect.objectContaining({ title: 'Riverside Blocks č' }));
        expect(downloads[0].name).toBe('riverside-blocks-c.ugt.json');
        await buttonOf(modals[0], 'geojson').click();
        expect(downloads[1].name).toBe('riverside-blocks-c.geojson');
    });

    it('downloads a plan revision with its members, view and schedule', async () => {
        const { win, modals, downloads } = browser();
        const ui = FileUI.browser(win);
        const plan = { cid: 'bafy-plan', content: { title: 'East quarter', view: { at: '45.8,15.9,17' }, schedule: { 'bafy-d': { start: 1 } } } };
        const members = [{ proposalId: 'm1' }];
        await ui.plan(plan, members);
        expect(win.PlanWorkspace.resolve).toHaveBeenCalledWith(plan, members);
        expect(modals[0].title).toBe('Download plan');
        expect(actionsOf(modals[0])).toEqual(['json', 'geojson']);
        await buttonOf(modals[0], 'json').click();
        expect(win.PlanFile.create).toHaveBeenCalledWith([{ proposalId: 'plan-member-bafy-d' }],
            expect.objectContaining({ title: 'East quarter', view: { at: '45.8,15.9,17' }, schedule: { 'bafy-d': { start: 1 } } }));
        expect(downloads[0].name).toBe('east-quarter.ugt.json');
    });

    it('downloads the current shared revision when it changes while the dialog stays open', async () => {
        const { win, downloads } = browser();
        const original = { content: { title: 'Original', view: { at: '45.8,15.9,17' } }, designs: [{ cid: 'old-design' }] };
        let current = original;
        const modal = { body: FileUI.browser(win).planControls(original, { getRow: () => current }) };
        current = { content: { title: 'Revised', view: { at: '45.9,15.9,18' }, schedule: { 'new-design': { start: '2027-01', end: '2027-03' } } },
            designs: [{ cid: 'new-design' }], designSources: { 'new-design': { sourceId: 'test-source' } } };
        await buttonOf(modal, 'json').click();
        expect(win.PlanFile.create).toHaveBeenCalledWith([{ proposalId: 'plan-member-new-design' }],
            expect.objectContaining({ title: 'Revised', view: current.content.view, schedule: current.content.schedule, designSources: current.designSources }));
        expect(downloads[0].name).toBe('revised.ugt.json');
        expect(original.designs[0].cid).toBe('old-design');
    });

    it('names an untitled download plan', async () => {
        const { win, modals, downloads } = browser();
        FileUI.browser(win).design({ proposalId: 'p1', title: '—' });
        await buttonOf(modals[0], 'geojson').click();
        expect(downloads[0].name).toBe('plan.geojson');
    });
});
