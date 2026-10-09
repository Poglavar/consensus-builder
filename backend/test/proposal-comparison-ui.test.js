// Headless interaction checks for proposal selection, stale results and read-only snapshot sharing.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/proposal-comparison-ui.js', import.meta.url)), 'utf8');

function node(tag) {
    const listeners = {};
    const attributes = {};
    const el = {
        tagName: String(tag).toUpperCase(),
        className: '',
        style: {},
        dataset: {},
        children: [],
        parentNode: null,
        listeners,
        attributes,
        textContent: '',
        value: '',
        checked: false,
        hidden: false,
        disabled: false,
        files: [],
        open: false,
        setAttribute(name, value) {
            attributes[name] = String(value);
            if (name === 'open') this.open = true;
            if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
        },
        getAttribute(name) { return attributes[name] ?? null; },
        removeAttribute(name) { delete attributes[name]; if (name === 'open') this.open = false; },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        removeEventListener(type, fn) {
            listeners[type] = (listeners[type] || []).filter(candidate => candidate !== fn);
        },
        appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
        removeChild(child) {
            this.children = this.children.filter(candidate => candidate !== child);
            child.parentNode = null;
            return child;
        },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); },
        get firstChild() { return this.children[0] || null; },
        get classList() {
            return { add: value => {
                const values = this.className.split(/\s+/).filter(Boolean);
                if (!values.includes(value)) values.push(value);
                this.className = values.join(' ');
            } };
        },
        focus() { this.focused = true; },
        select() { this.selected = true; },
        showModal() { this.open = true; attributes.open = ''; },
        close() { this.open = false; delete attributes.open; },
        click() {
            const event = { target: this, preventDefault() { this.defaultPrevented = true; } };
            let current = this;
            while (current) {
                (current.listeners.click || []).forEach(fn => fn(event));
                current = current.parentNode;
            }
        },
        set innerHTML(value) { this._innerHTML = value; this.children = []; },
        get innerHTML() { return this._innerHTML || ''; },
        querySelectorAll(selector) {
            const out = [];
            const match = candidate => {
                const data = selector.match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/);
                if (data) {
                    const attr = 'data-' + data[1];
                    const value = candidate.getAttribute(attr);
                    return data[2] === undefined ? value !== null : value === data[2];
                }
                if (selector.startsWith('.')) return candidate.className.split(/\s+/).includes(selector.slice(1));
                return candidate.tagName.toLowerCase() === selector.toLowerCase();
            };
            const walk = parent => parent.children.forEach(child => {
                if (match(child)) out.push(child);
                walk(child);
            });
            walk(this);
            return out;
        },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    };
    return el;
}

function feature(n) {
    return {
        type: 'Feature',
        properties: { parcelId: 'parcel-' + n },
        geometry: { type: 'Polygon', coordinates: [[[n, 0], [n + 1, 0], [n + 1, 1], [n, 1], [n, 0]]] }
    };
}
function makeHarness({ proposals, hash = '', snapshot = null } = {}) {
    const body = node('body');
    const document = {
        body,
        readyState: 'complete',
        listeners: {},
        createElement: node,
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        getElementById(id) {
            const walk = current => {
                if (current.id === id) return current;
                for (const child of current.children) { const found = walk(child); if (found) return found; }
                return null;
            };
            return walk(body);
        }
    };
    const calls = { compare: [], capture: [], previews: [], repository: [], live: 0, writes: 0 };
    const repository = {
        get: vi.fn(id => { calls.repository.push(id); return feature(id === 'parcel-2' ? 2 : 0); })
    };
    const output = input => ({
        engineVersion: 'test-engine-1',
        scope: input.scope || { geometry: feature(0).geometry, source: 'union-of-alternatives', areaM2: 100 },
        assumptions: input.assumptions,
        alternatives: input.alternatives.map((alternative, index) => ({
            name: alternative.name,
            proposalIds: alternative.proposals.map(p => String(p.proposalId)),
            metrics: {
                proposalCount: alternative.proposals.length,
                siteAreaM2: index === 0 ? 100 : null,
                buildingCount: index === 0 ? 2 : 1,
                buildingFootprintM2: 40,
                grossFloorAreaM2: 120,
                floorAreaRatio: 1.2,
                housingUnits: 3,
                people: 7,
                jobs: 4,
                parkAreaM2: 10,
                squareAreaM2: 0,
                waterAreaM2: 5,
                roadAreaM2: 12
            },
            issues: index ? [{ code: 'issue-b', message: '<script>unsafe issue</script>' }] : [],
            features: { type: 'FeatureCollection', features: [
                { type: 'Feature', properties: { kind: 'site' }, geometry: feature(index).geometry },
                { type: 'Feature', properties: { kind: 'building' }, geometry: feature(index + 1).geometry }
            ] }
        })),
        deltas: { siteAreaM2: null, proposalCount: 0, buildingCount: -1, buildingFootprintM2: 0,
            grossFloorAreaM2: 0, floorAreaRatio: 0, housingUnits: 0, people: 0, jobs: 0,
            parkAreaM2: 0, squareAreaM2: 0, waterAreaM2: 0, roadAreaM2: 0 },
        issues: [{ code: 'scope', message: 'Shared-scope diagnostic' }]
    });
    const comparison = {
        DEFAULTS: { floorHeightM: 3.2, housingShare: 0.7, efficiency: 0.82, avgApartmentM2: 68, personsPerApartment: 2.1, m2PerJob: 31 },
        captureInput: vi.fn(input => {
            calls.capture.push(input);
            return JSON.parse(JSON.stringify(input));
        }),
        compare: vi.fn(input => { calls.compare.push(input); return output(input); })
    };
    const parcelCompare = {
        previewSvg: vi.fn((scope, layers, options) => {
            calls.previews.push({ scope, layers, options });
            return '<svg xmlns="http://www.w3.org/2000/svg"><text>safe</text></svg>';
        })
    };
    const codec = {
        create: vi.fn((input, result, opts) => ({ format: 'ugt-comparison', version: 1, createdAt: opts.createdAt,
            engineVersion: result.engineVersion, input, result })),
        stringify: vi.fn(value => JSON.stringify(value)),
        parse: vi.fn(text => JSON.parse(text)),
        toHash: vi.fn(() => '#comparison=v1.fake'),
        fromHash: vi.fn(() => snapshot)
    };
    const store = {
        getAllProposals: vi.fn(() => proposals || []),
        addProposal: vi.fn(() => { calls.writes += 1; }),
        save: vi.fn(() => { calls.writes += 1; })
    };
    const downloadUrl = class extends URL {
        static createObjectURL(blob) { calls.downloadBlob = blob; return 'blob:comparison-test'; }
        static revokeObjectURL(url) { calls.revokedDownloadUrl = url; }
    };
    const window = {
        document,
        location: { href: 'https://example.test/app?city=Oslo&lang=en&token=drop#old', origin: 'https://example.test', pathname: '/app', search: '?city=Oslo&lang=en&token=drop', hash },
        navigator: { clipboard: { writeText: vi.fn(async text => { calls.copied = text; }) } },
        URL: downloadUrl,
        URLSearchParams,
        Blob,
        proposalStorage: store,
        CadastralParcelRepository: repository,
        LiveParcelFabric: { get: () => { calls.live += 1; return feature(99); } },
        turf: { union: (a, b) => ({ type: 'Feature', properties: {}, geometry: {
            type: 'MultiPolygon', coordinates: [a.geometry.coordinates, b.geometry.coordinates]
        } }) },
        __proposalComparison: comparison,
        __parcelCompare: parcelCompare,
        ComparisonSnapshot: codec,
        console
    };
    const context = vm.createContext({ window, document, URL, URLSearchParams, Blob, console });
    vm.runInContext(source, context, { filename: 'proposal-comparison-ui.js' });
    return { window, document, body, calls, comparison, codec, store, parcelCompare };
}
function find(root, selector) { return root.querySelector(selector); }
function all(root, selector) { return root.querySelectorAll(selector); }
function clickAction(root, name, side) {
    const button = all(root, '[data-action="' + name + '"]').find(item => !side || item.getAttribute('data-side') === side);
    if (!button) throw new Error('missing action ' + name);
    button.click();
    return button;
}

const proposals = [
    { proposalId: 'p-applied-a', title: '<img src=x onerror=alert(1)> A', applied: true, cadastreParcelIds: ['parcel-1'] },
    { proposalId: 'p-draft', title: 'Draft B', applied: false, cadastreParcelIds: ['parcel-1'] },
    { proposalId: 'p-applied-c', title: 'Applied C', applied: true, cadastreParcelIds: ['parcel-2'] }
];

describe('ProposalComparison UI', () => {
    it('compares selected local proposals against one immutable shared scope and renders null as a dash', async () => {
        const h = makeHarness({ proposals });
        const dialog = h.window.ProposalComparison.open({ proposalIds: ['p-draft', 'p-applied-c'] });
        expect(dialog.open).toBe(true);
        const draftChecks = all(dialog, '[data-proposal-id="p-draft"]');
        expect(draftChecks).toHaveLength(2);
        expect(draftChecks[0].checked).toBe(true);
        expect(draftChecks[1].checked).toBe(false);

        clickAction(dialog, 'use-applied', 'a');
        clickAction(dialog, 'compare');
        await Promise.resolve();
        await Promise.resolve();

        expect(h.comparison.captureInput).toHaveBeenCalled();
        expect(h.comparison.compare).toHaveBeenCalledTimes(1);
        const input = h.calls.compare[0];
        expect(input.alternatives[0].proposals.map(p => p.proposalId)).toEqual(['p-applied-a', 'p-applied-c']);
        expect(input.alternatives[1].proposals.map(p => p.proposalId)).toEqual(['p-applied-c']);
        expect(input.scope).toBeNull();
        expect(input.context.parcels.map(p => p.id)).toEqual(['parcel-1', 'parcel-2']);
        expect(h.calls.repository).toEqual(['parcel-1', 'parcel-2']);
        expect(h.calls.live).toBe(0);
        expect(h.calls.writes).toBe(0);
        expect(h.calls.previews).toHaveLength(2);
        expect(h.calls.previews[0].scope).toEqual(h.calls.previews[1].scope);
        expect(h.calls.previews[0].layers.map(layer => layer.className)).toEqual(['comparison-preview__building']);
        expect(h.calls.previews[0].options.label).toContain('A');

        const cells = all(dialog, 'td').map(cell => cell.textContent);
        expect(cells).toContain('—');
        const issue = all(dialog, '.comparison-issue').find(item => item.textContent === '<script>unsafe issue</script>');
        expect(issue).toBeTruthy();
        expect(issue.innerHTML).toBe('');
        expect(h.body.innerHTML).toBe('');
        const caveat = all(dialog, '.comparison-caveat')[0];
        expect(caveat.textContent).toContain('Existing buildings');
        clickAction(dialog, 'save');
        expect(h.codec.create).toHaveBeenCalledTimes(1);
        const exported = JSON.parse(await h.calls.downloadBlob.text());
        expect(exported.format).toBe('ugt-comparison');
        expect(exported.input.alternatives[0].proposals.map(p => p.proposalId)).toEqual(['p-applied-a', 'p-applied-c']);
        expect(exported.input.scope.geometry).toEqual(h.calls.previews[0].scope);
        expect(exported.result.alternatives[1].metrics.siteAreaM2).toBeNull();
        expect(h.calls.revokedDownloadUrl).toBe('blob:comparison-test');
        clickAction(dialog, 'copy-link');
        expect(h.calls.copied).toContain('city=Oslo');
        expect(h.calls.copied).toContain('lang=en');
        expect(h.calls.copied).not.toContain('token=drop');
        expect(h.calls.copied).toContain('#comparison=v1.fake');
    });

    it('opens snapshots without recalculating, then recalculates only on explicit action', async () => {
        const h = makeHarness({ proposals });
        const input = {
            alternatives: [
                { name: 'Old A', proposals: [proposals[0]] },
                { name: 'Old B', proposals: [proposals[1]] }
            ],
            scope: { geometry: feature(0).geometry, source: 'snapshot scope' },
            assumptions: { floorHeightM: 3, housingShare: 0.75, efficiency: 0.8, avgApartmentM2: 65, personsPerApartment: 2.4, m2PerJob: 30 },
            context: { city: 'Test City', parcels: [{ id: 'parcel-1', feature: feature(0) }] }
        };
        const result = {
            engineVersion: 'saved-engine', scope: input.scope,
            alternatives: [
                { name: 'Old A', proposalIds: ['p-applied-a'], metrics: {}, issues: [], features: { type: 'FeatureCollection', features: [] } },
                { name: 'Old B', proposalIds: ['p-draft'], metrics: {}, issues: [], features: { type: 'FeatureCollection', features: [] } }
            ],
            deltas: {}, issues: []
        };
        const snapshot = { format: 'ugt-comparison', version: 1, createdAt: '2026-10-08T09:00:00.000Z', engineVersion: 'saved-engine', input, result };
        const dialog = h.window.ProposalComparison.openSnapshot(snapshot);
        expect(h.comparison.compare).not.toHaveBeenCalled();
        expect(all(dialog, '.comparison-saved-meta')[0].textContent).toContain('read-only');
        expect(all(dialog, '.comparison-metadata')[0].textContent).toContain('saved-engine');

        clickAction(dialog, 'recalculate');
        await Promise.resolve();
        await Promise.resolve();
        expect(h.comparison.compare).toHaveBeenCalledTimes(1);
        expect(h.comparison.compare.mock.calls[0][0].alternatives[0].name).toBe('Old A');
        expect(h.calls.writes).toBe(0);
    });

    it('keeps invalid assumption input visible and does not silently replace it with defaults', async () => {
        const h = makeHarness({ proposals });
        const dialog = h.window.ProposalComparison.open({ proposalIds: ['p-applied-a', 'p-draft'] });
        const floorHeight = all(dialog, '[data-assumption="floorHeightM"]')[0];
        floorHeight.value = '-2';
        clickAction(dialog, 'compare');
        await Promise.resolve();
        expect(floorHeight.value).toBe('-2');
        expect(floorHeight.getAttribute('aria-invalid')).toBe('true');
        expect(h.comparison.compare).not.toHaveBeenCalled();
        expect(find(dialog, '.comparison-error').textContent).toContain('Floor height');
    });

    it('invalidates a report and disables sharing when its selection or assumptions change', async () => {
        const h = makeHarness({ proposals });
        const dialog = h.window.ProposalComparison.open({ proposalIds: ['p-applied-a', 'p-draft'] });
        clickAction(dialog, 'compare');
        await Promise.resolve(); await Promise.resolve();
        expect(find(dialog, '[data-action="save"]').disabled).toBe(false);
        const assumption = find(dialog, '[data-assumption="housingShare"]');
        assumption.value = '50';
        assumption.listeners.input[0]();
        expect(find(dialog, '[data-role="result"]').hidden).toBe(true);
        expect(find(dialog, '[data-action="save"]').disabled).toBe(true);
        expect(find(dialog, '[data-action="copy-link"]').disabled).toBe(true);
        expect(find(dialog, '.comparison-error').textContent).toContain('Compare again');
        clickAction(dialog, 'compare');
        await Promise.resolve(); await Promise.resolve();
        expect(h.calls.compare[1].assumptions.housingShare).toBe(0.5);
        expect(find(dialog, '[data-action="save"]').disabled).toBe(false);
    });

    it('loads a JSON snapshot as a read-only preview without importing proposals', async () => {
        const h = makeHarness({ proposals });
        const snapshot = {
            format: 'ugt-comparison', version: 1, createdAt: '2026-10-08T10:00:00.000Z', engineVersion: 'file-engine',
            input: { alternatives: [
                { name: 'File A', proposals: [proposals[0]] },
                { name: 'File B', proposals: [proposals[1]] }
            ], scope: null, assumptions: {}, context: { city: 'Test' } },
            result: { engineVersion: 'file-engine', scope: null, alternatives: [
                { name: 'File A', proposalIds: ['p-applied-a'], metrics: {}, issues: [], features: { type: 'FeatureCollection', features: [] } },
                { name: 'File B', proposalIds: ['p-draft'], metrics: {}, issues: [], features: { type: 'FeatureCollection', features: [] } }
            ], deltas: {}, issues: [] }
        };
        const dialog = h.window.ProposalComparison.open();
        const input = all(dialog, 'input').find(item => item.className === 'comparison-file');
        const file = { text: vi.fn(async () => JSON.stringify(snapshot)) };
        input.files = [file];
        clickAction(dialog, 'load');
        input.listeners.change[0]();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(h.codec.parse).toHaveBeenCalledTimes(1);
        expect(h.comparison.compare).not.toHaveBeenCalled();
        expect(h.store.addProposal).not.toHaveBeenCalled();
        expect(all(dialog, '.comparison-saved-meta')[0].textContent).toContain('read-only');
    });

    it('loads a comparison hash at startup as a saved result, never as an implicit recalculation', () => {
        const snapshot = { format: 'ugt-comparison', version: 1, createdAt: '2026-10-08', engineVersion: 'saved', input: { alternatives: [{name:'A',proposals:[]},{name:'B',proposals:[]}] }, result: {
            engineVersion: 'saved', scope: null, alternatives: [
                { name: 'A', proposalIds: [], metrics: {}, issues: [], features: { type: 'FeatureCollection', features: [] } },
                { name: 'B', proposalIds: [], metrics: {}, issues: [], features: { type: 'FeatureCollection', features: [] } }
            ], deltas: {}, issues: []
        } };
        const h = makeHarness({ proposals, hash: '#comparison=v1.fake', snapshot });
        expect(h.codec.fromHash).toHaveBeenCalledWith('#comparison=v1.fake');
        expect(h.comparison.compare).not.toHaveBeenCalled();
        expect(h.window.ProposalComparison).toBeTruthy();
        expect(all(h.body, '.comparison-saved-meta')[0].textContent).toContain('read-only');
    });
});
