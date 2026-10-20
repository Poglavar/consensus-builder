import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const viewerSource = readFileSync(fileURLToPath(new URL('../../frontend/novogradnje/viewer.js', import.meta.url)), 'utf8');
const locatedProject = { location: { lng: 16, lat: 45 }, model: { envelope: { footprint: { type: 'Polygon', coordinates: [[[16,45],[16.001,45],[16.001,45.001],[16,45]]] } } } };
const envelopeModel = { envelope: { ...locatedProject.model.envelope, storeys: [{ level: 0 }] } };
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

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
        NovogradnjeLoading: { start: vi.fn(() => vi.fn()) },
        __apartmentPeople: { mount: vi.fn(() => vi.fn()) },
        __apartmentSun: { mount: vi.fn(() => vi.fn()) },
        ...overrides
    };
    vm.runInNewContext(viewerSource, { window: root, document, fetch: root.fetch, AbortController, URLSearchParams });
    return root;
}

describe('Novogradnje viewer mounts', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each(['ready', 'error'])('keeps the envelope loading until the renderer settles: %s', async outcome => {
        const preview = deferred(), root = loadViewer({ __floorPlanReviewRenderer: { preview: vi.fn(() => preview.promise) } });
        const host = makeElement('host');
        root.NovogradnjeViewer.mountEnvelope(host, envelopeModel);
        const stop = root.NovogradnjeLoading.start.mock.results[0].value;
        expect(root.NovogradnjeLoading.start).toHaveBeenCalledWith(host, 'Učitavanje 3D prikaza zgrade…');
        expect(stop).not.toHaveBeenCalled();
        if (outcome === 'ready') preview.resolve(vi.fn());
        else preview.reject(new Error('Unavailable'));
        await flush();
        expect(stop).toHaveBeenCalledOnce();
        if (outcome === 'error') expect(host.children[0].textContent).toContain('3D prikaz zgrade nije dostupan');
    });

    it('stops envelope loading on disposal and disposes a late renderer', async () => {
        const preview = deferred(), dispose = vi.fn();
        const root = loadViewer({ __floorPlanReviewRenderer: { preview: vi.fn(() => preview.promise) } }), host = makeElement('host');
        const mounted = root.NovogradnjeViewer.mountEnvelope(host, envelopeModel);
        const stop = root.NovogradnjeLoading.start.mock.results[0].value;
        mounted.dispose();
        expect(stop).toHaveBeenCalled();
        preview.resolve(dispose);
        await flush();
        expect(dispose).toHaveBeenCalledOnce();
        expect(host.children).toHaveLength(0);
    });

    it.each(['ready', 'error'])('keeps the apartment loading until the renderer settles: %s', async outcome => {
        const preview = deferred(), root = loadViewer({ __floorPlanReviewRenderer: { preview: vi.fn(() => preview.promise) } });
        const host = makeElement('host');
        root.NovogradnjeViewer.mountApartment(host, { architecture: { dimensionsM: [4, 5] } });
        const stop = root.NovogradnjeLoading.start.mock.results[0].value;
        expect(root.NovogradnjeLoading.start).toHaveBeenCalledWith(host.children[0], 'Učitavanje 3D prikaza stana…');
        expect(stop).not.toHaveBeenCalled();
        if (outcome === 'ready') preview.resolve(vi.fn());
        else preview.reject(new Error('Unavailable'));
        await flush();
        expect(stop).toHaveBeenCalledOnce();
        if (outcome === 'error') expect(host.children[0].children[0].textContent).toContain('3D prikaz nije dostupan');
    });

    it('stops loading in 2D and keeps a later 3D load active when the earlier renderer resolves', async () => {
        const first = deferred(), second = deferred(), disposeFirst = vi.fn();
        const root = loadViewer({ __floorPlanReviewRenderer: { preview: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) } });
        const host = makeElement('host');
        root.NovogradnjeViewer.mountApartment(host, { architecture: { dimensionsM: [4, 5] } });
        const button = host.children[1].children[0], stopFirst = root.NovogradnjeLoading.start.mock.results[0].value;
        button.click();
        expect(stopFirst).toHaveBeenCalled();
        expect(host.children[0].children[0].tag).toBe('svg');
        expect(root.NovogradnjeLoading.start).toHaveBeenCalledOnce();
        button.click();
        const stopSecond = root.NovogradnjeLoading.start.mock.results[1].value;
        first.resolve(disposeFirst);
        await flush();
        expect(disposeFirst).toHaveBeenCalledOnce();
        expect(stopSecond).not.toHaveBeenCalled();
        second.resolve(vi.fn());
        await flush();
        expect(stopSecond).toHaveBeenCalledOnce();
    });

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
        expect(root.NovogradnjeLoading.start.mock.results[0].value).toHaveBeenCalled();
        resolvePreview(disposeRenderer);
        await new Promise(resolve => setImmediate(resolve));
        expect(disposeRenderer).toHaveBeenCalledOnce();
    });

    it('mounts sunlight and people together and disposes both with the apartment renderer', async () => {
        const root = loadViewer(), host = makeElement('host');
        const apartment = { architecture: { dimensionsM: [4, 5] }, placement: { status: 'placed', best: { rotationDeg: 45 } } };
        const location = { lat: 45, lng: 16 };
        root.NovogradnjeViewer.mountApartment(host, apartment, { location });
        const setup = root.__floorPlanReviewRenderer.preview.mock.calls[0][3].setup;
        const dispose = setup({ scene: {}, group: {}, renderer: {} });
        expect(root.__apartmentSun.mount).toHaveBeenCalledWith(expect.objectContaining({ architecture: apartment.architecture, placement: apartment.placement, location, controlsHost: host }));
        expect(root.__apartmentPeople.mount).toHaveBeenCalledOnce();
        dispose();
        expect(root.__apartmentSun.mount.mock.results[0].value).toHaveBeenCalledOnce();
        expect(root.__apartmentPeople.mount.mock.results[0].value).toHaveBeenCalledOnce();
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

    it('keeps context loading through its request and renderer initialization', async () => {
        const request = deferred(), preview = deferred();
        const root = loadViewer({ fetch: vi.fn(() => request.promise), __floorPlanReviewRenderer: { preview: vi.fn(() => preview.promise) } });
        const host = makeElement('host');
        root.NovogradnjeViewer.mountContext(host, { ...locatedProject, id: 'project' });
        const stop = root.NovogradnjeLoading.start.mock.results[0].value;
        expect(root.NovogradnjeLoading.start).toHaveBeenCalledWith(host.children[0].children[0], 'Učitavanje neposredne okolice…');
        expect(stop).not.toHaveBeenCalled();
        request.resolve({ ok: true, json: async () => ({ buildings: [{ id: 'b' }], groundZ: 10 }) });
        await flush();
        expect(root.__floorPlanReviewRenderer.preview).toHaveBeenCalledOnce();
        expect(stop).not.toHaveBeenCalled();
        preview.resolve(vi.fn());
        await flush();
        expect(stop).toHaveBeenCalledOnce();
    });

    it.each(['request', 'renderer'])('stops context loading when its %s fails', async failure => {
        const root = loadViewer(), host = makeElement('host');
        if (failure === 'request') root.fetch.mockRejectedValue(new Error('Unavailable'));
        else {
            root.fetch.mockResolvedValue({ ok: true, json: async () => ({ buildings: [{ id: 'b' }], groundZ: 10 }) });
            root.__floorPlanReviewRenderer.preview.mockRejectedValue(new Error('Unavailable'));
        }
        root.NovogradnjeViewer.mountContext(host, locatedProject);
        await flush();
        expect(root.NovogradnjeLoading.start.mock.results[0].value).toHaveBeenCalledOnce();
        expect(host.children[0].children[0].children[0].textContent).toContain('3D prikaz okolice trenutačno nije dostupan');
    });

    it('stops a cancelled context load without clearing the next mode loading when it resolves', async () => {
        const preview = deferred(), google = deferred(), disposePreview = vi.fn();
        const root = loadViewer({ __floorPlanReviewRenderer: { preview: vi.fn(() => preview.promise) }, NovogradnjeGoogleContext: { mount: vi.fn(() => google.promise) } });
        root.fetch.mockResolvedValue({ ok: true, json: async () => ({ buildings: [{ id: 'b' }], groundZ: 10 }) });
        const host = makeElement('host');
        root.NovogradnjeViewer.mountContext(host, locatedProject);
        await flush();
        const stopModel = root.NovogradnjeLoading.start.mock.results[0].value;
        host.children[0].children[1].children[1].click();
        const stopGoogle = root.NovogradnjeLoading.start.mock.results[1].value;
        expect(stopModel).toHaveBeenCalled();
        expect(stopGoogle).not.toHaveBeenCalled();
        preview.resolve(disposePreview);
        await flush();
        expect(disposePreview).toHaveBeenCalledOnce();
        expect(stopGoogle).not.toHaveBeenCalled();
        google.resolve(vi.fn());
        await flush();
        expect(stopGoogle).toHaveBeenCalledOnce();
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
        expect(root.NovogradnjeLoading.start.mock.results[0].value).toHaveBeenCalled();
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
        expect(root.NovogradnjeLoading.start.mock.results[0].value).toHaveBeenCalledOnce();
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
        expect(root.NovogradnjeLoading.start.mock.results[0].value).toHaveBeenCalled();
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
