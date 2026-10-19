import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const viewerSource = readFileSync(fileURLToPath(new URL('../../frontend/novogradnje/viewer.js', import.meta.url)), 'utf8');
const locatedProject = { location: { lng: 16, lat: 45 }, model: { envelope: { footprint: { type: 'Polygon', coordinates: [[[16,45],[16.001,45],[16.001,45.001],[16,45]]] } } } };

function makeElement(tag) {
    return {
        tag, children: [], listeners: {}, className: '', textContent: '', type: '',
        setAttribute(name, value) { this[name] = value; },
        replaceChildren(...children) { this.children = children; },
        append(...children) { this.children.push(...children); },
        addEventListener(name, fn) { this.listeners[name] = fn; },
        click() { this.listeners.click?.(); }
    };
}

function loadViewer(overrides = {}) {
    const document = { createElement: makeElement, createElementNS: (_ns, tag) => makeElement(tag) };
    const root = {
        document,
        AbortController,
        fetch: vi.fn(),
        __floorPlanReviewRenderer: { preview: vi.fn(async () => vi.fn()) },
        __threeFloorPlans: { createLocalUnitGroup: vi.fn() },
        __buildingFloorPlans: {},
        __siteModelGeometry: {},
        NovogradnjeCatalogue: {},
        ContextBuildings3D: {},
        NovogradnjeGoogleContext: { mount: vi.fn(async () => vi.fn()) },
        ...overrides
    };
    vm.runInNewContext(viewerSource, { window: root, document, fetch: root.fetch, AbortController, URLSearchParams });
    return root;
}

describe('Novogradnje viewer mounts', () => {
    afterEach(() => vi.restoreAllMocks());

    it('starts apartment plans in 3D and keeps rotation disabled after the first interaction and later toggles', async () => {
        const root = loadViewer();
        const host = makeElement('host');
        root.NovogradnjeViewer.mountApartment(host, { architecture: { dimensionsM: [4, 5] } });
        await new Promise(resolve => setImmediate(resolve));
        const button = host.children[1].children[0];
        const firstOptions = root.__floorPlanReviewRenderer.preview.mock.calls[0][3];
        expect(firstOptions.autoRotate).toBe(true);
        firstOptions.onInteraction();

        button.click();
        await new Promise(resolve => setImmediate(resolve));
        button.click();
        await new Promise(resolve => setImmediate(resolve));
        expect(root.__floorPlanReviewRenderer.preview).toHaveBeenCalledTimes(2);
        expect(root.__floorPlanReviewRenderer.preview.mock.calls[1][3].autoRotate).toBe(false);
    });

    it('disposes a renderer that resolves after the apartment view is unmounted', async () => {
        let resolvePreview;
        const disposeRenderer = vi.fn();
        const root = loadViewer({ __floorPlanReviewRenderer: { preview: vi.fn(() => new Promise(resolve => { resolvePreview = resolve; })) } });
        const host = makeElement('host');
        const view = root.NovogradnjeViewer.mountApartment(host, { architecture: { dimensionsM: [4, 5] } });
        view.dispose();
        resolvePreview(disposeRenderer);
        await new Promise(resolve => setImmediate(resolve));
        expect(disposeRenderer).toHaveBeenCalledOnce();
    });

    it('requests context by project id and allows zoom without panning', async () => {
        const root = loadViewer();
        root.fetch.mockResolvedValue({ ok: true, json: async () => ({ buildings: [{ id: 'b' }], groundZ: 10 }) });
        const host = makeElement('host');
        root.NovogradnjeViewer.mountContext(host, { ...locatedProject, id: 'proj 1' });
        await new Promise(resolve => setImmediate(resolve));
        expect(root.fetch).toHaveBeenCalledWith('/novogradnje/api/projects/proj%201/context', expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(root.__floorPlanReviewRenderer.preview.mock.calls[0][3]).toEqual({
            enablePan: false, enableZoom: true, minPolarAngle: .15, maxPolarAngle: Math.PI * .48, focusName: 'context-project'
        });
        expect(root.NovogradnjeGoogleContext.mount).not.toHaveBeenCalled();
    });

    it('loads Google context only when selected, disposes it on return to Model, and reuses the model response', async () => {
        const root = loadViewer();
        root.fetch.mockResolvedValue({ ok: true, json: async () => ({ buildings: [{ id: 'b' }], groundZ: 10 }) });
        const host = makeElement('host');
        const mounted = root.NovogradnjeViewer.mountContext(host, { ...locatedProject, id: 'project' });
        await new Promise(resolve => setImmediate(resolve));
        const [modelButton, googleButton] = host.children[0].children[1].children;
        googleButton.click();
        await new Promise(resolve => setImmediate(resolve));
        expect(googleButton['aria-pressed']).toBe('true');
        expect(root.NovogradnjeGoogleContext.mount).toHaveBeenCalledOnce();
        const disposeGoogle = await root.NovogradnjeGoogleContext.mount.mock.results[0].value;
        modelButton.click();
        await new Promise(resolve => setImmediate(resolve));
        expect(disposeGoogle).toHaveBeenCalledOnce();
        expect(root.fetch).toHaveBeenCalledOnce();
        expect(root.__floorPlanReviewRenderer.preview).toHaveBeenCalledTimes(2);
        mounted.dispose();
    });

    it('disposes a Google preview that finishes after the context view is unmounted', async () => {
        let resolveGoogle;
        const root = loadViewer({ location: { search: '?context=google' }, NovogradnjeGoogleContext: { mount: vi.fn(() => new Promise(resolve => { resolveGoogle = resolve; })) } });
        const host = makeElement('host');
        const mounted = root.NovogradnjeViewer.mountContext(host, locatedProject);
        mounted.dispose();
        const disposeGoogle = vi.fn();resolveGoogle(disposeGoogle);
        await new Promise(resolve => setImmediate(resolve));
        expect(disposeGoogle).toHaveBeenCalledOnce();
        expect(root.fetch).not.toHaveBeenCalled();
    });

    it('keeps the Model button available when Google fails and permits retry', async () => {
        const root = loadViewer({ location: { search: '?context=google' } });
        root.NovogradnjeGoogleContext.mount.mockRejectedValueOnce(new Error('Unavailable'));
        const host = makeElement('host');
        root.NovogradnjeViewer.mountContext(host, locatedProject);
        await new Promise(resolve => setImmediate(resolve));
        const [view, toolbar] = host.children[0].children;
        expect(view.children[0].textContent).toContain('Google 3D trenutačno nije dostupan');
        toolbar.children[1].click();
        await new Promise(resolve => setImmediate(resolve));
        expect(root.NovogradnjeGoogleContext.mount).toHaveBeenCalledTimes(2);
    });

    it('aborts the context request when its view is unmounted', () => {
        const root = loadViewer();
        root.fetch.mockReturnValue(new Promise(() => {}));
        const host = makeElement('host');
        const view = root.NovogradnjeViewer.mountContext(host, { ...locatedProject, id: 'project' });
        const signal = root.fetch.mock.calls[0][1].signal;
        view.dispose();
        expect(signal.aborted).toBe(true);
    });

    it.each([
        { ...locatedProject, location: null },
        { ...locatedProject, location: { lng: null, lat: null } },
        { ...locatedProject, model: {} }
    ])('shows an explicit unknown-location state without requesting context: %j', project => {
        const root = loadViewer();
        const host = makeElement('host');
        const view = root.NovogradnjeViewer.mountContext(host, project);
        expect(host.children[0].textContent).toBe('Nepoznata lokacija — okolica se ne može prikazati.');
        expect(root.fetch).not.toHaveBeenCalled();
        expect(root.__floorPlanReviewRenderer.preview).not.toHaveBeenCalled();
        view.dispose();
        expect(host.children).toHaveLength(0);
    });
});
