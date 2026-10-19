import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const indexSource = readFileSync(fileURLToPath(new URL('../../frontend/novogradnje/index.js', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('../../frontend/novogradnje/index.css', import.meta.url)), 'utf8');

function element(tag) {
    return {
        tag, children: [], listeners: {}, className: '', textContent: '', value: '', hidden: false,
        classList: { add() {}, contains: () => false },
        get childNodes() { return this.children; },
        get firstChild() { return this.children[0]; },
        append(...nodes) { this.children.push(...nodes); },
        prepend(...nodes) { this.children.unshift(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; },
        addEventListener(name, listener) { this.listeners[name] = listener; },
        setAttribute(name, value) { this[name] = value; },
        focus() {}
    };
}

function renderDetail({ selected = false, fallbackPaths = false, located = true, storeys = true } = {}) {
    const ids = ['detail','novogradnje-boot','q','kind','minArea','maxArea','rooms','orientation','clear-search','filters','reset','include-older','catalogue-error','results','catalogue-count','result-summary','empty-state','project-map'];
    const nodes = Object.fromEntries(ids.map(id => [id, element(id)]));
    nodes['novogradnje-boot'].textContent = JSON.stringify({
        catalogue: { projects: [] },
        project: {
            id: 'project-a', name: 'Projekt A', address: 'Ulica 1', kind: 'new_build', constructionYear: 2028,
            url: fallbackPaths ? undefined : '/novogradnje/zgrade/projekt-a/',
            sources: [{ url: 'https://example.test/project', label: 'Oglas projekta' }],
            location: located ? { lng: 16, lat: 45 } : null,
            model: { envelope: located ? { footprint: { type: 'Polygon' }, storeys: storeys ? [{ level: 1, elevationM: 3 }] : [] } : null },
            apartments: [{ id: 'apt-1', label: 'Stan 1', hasPlan: true, postingUrl: 'https://example.test/apartment', architecture: { dimensionsM: [4, 5] }, source: { assetUrl: 'https://example.test/plan.png', url: 'https://example.test/plan' } }],
            floorPlans: [{ id: 'floor-2', label: 'Tlocrt drugog kata', scope: 'floor', levels: [2], url: fallbackPaths ? undefined : '/novogradnje/zgrade/projekt-a/tlocrti/floor-2/', architecture: { dimensionsM: [20, 12] }, source: { assetUrl: 'https://example.test/floor.pdf', mediaType: 'application/pdf', page: 4, url: 'https://example.test/floor' } }]
        },
        apartmentId: selected === true ? 'apt-1' : null,
        floorPlanId: selected === 'floor' ? 'floor-2' : null
    });
    const body = element('body');
    body.classList = { add() {}, contains: name => name === 'detail-page' };
    const viewer = { mountApartment: vi.fn(() => ({ dispose() {} })), mountEnvelope: vi.fn(() => ({ dispose() {} })), mountContext: vi.fn(() => ({ dispose() {} })) };
    const catalogue = { decodeFilters: () => ({}), normalizeFilters: value => value, encodeFilters: () => '', filterProjects: () => [], hasEnvelope: model => Boolean(model?.envelope?.footprint && model.envelope.storeys?.length) };
    const location = { search: '', href: 'https://example.test/novogradnje/' };
    const context = {
        window: { NovogradnjeCatalogue: catalogue, NovogradnjeViewer: viewer },
        document: { body, createElement: element, getElementById: id => nodes[id] },
        location, history: { replaceState() {}, pushState() {} },
        addEventListener() {}, URL, URLSearchParams, Intl, Number, String, Boolean, Array, Object, Math, JSON
    };
    vm.runInNewContext(indexSource, context);
    return { detail: nodes.detail, viewer };
}

function descendants(root) {
    return root.children.flatMap(child => [child, ...descendants(child)]);
}

describe('Novogradnje detail layout', () => {
    it('renders exactly four separate sibling panels for an apartment and keeps sources in the source panel', () => {
        const { detail } = renderDetail({ selected: true });
        const panels = descendants(detail).filter(node => node.className.split(' ').includes('viewer-panel'));
        expect(panels).toHaveLength(4);
        expect(panels.map(panel => panel.children[0].textContent)).toEqual([
            'Tlocrt i 3D prikaz', 'Obris i katovi zgrade', 'Izvorni tlocrt', 'Kontekst zgrade'
        ]);
        expect(descendants(panels[2]).filter(node => node.className === 'source-link')).toHaveLength(3);
        expect(panels.slice(0, 2).flatMap(descendants).some(node => node.className === 'source-link')).toBe(false);
    });

    it('shows building apartments as source-free rows beside the two stacked building views', () => {
        const { detail } = renderDetail();
        const rows = descendants(detail).filter(node => node.className === 'apartment-row');
        expect(rows).toHaveLength(1);
        expect(descendants(rows[0]).map(node => node.textContent).join(' ')).not.toMatch(/Tlocrt dostupan|Otvori izvor/);
        expect(descendants(detail).filter(node => node.className === 'detail-sources')).toHaveLength(0);
        expect(descendants(detail).filter(node => node.className === 'source-link')).toHaveLength(0);
        expect(descendants(detail).filter(node => node.className.split(' ').includes('viewer-panel')).map(node => node.children[0].textContent)).toEqual(['Kontekst zgrade', 'Obris i katovi zgrade']);
        const layout = descendants(detail).find(node => node.className === 'building-detail-layout');
        expect(layout.children.map(node => node.className)).toEqual(['building-viewer-stack', 'building-apartment-column']);
    });

    it('lists floor plans separately and opens a floor detail with its source PDF page', () => {
        const building = renderDetail().detail;
        const floorRow = descendants(building).find(node => node.className.split(' ').includes('floor-plan-row'));
        expect(floorRow.children[0].href).toBe('/novogradnje/zgrade/projekt-a/tlocrti/floor-2/');
        expect(floorRow.children[0].children[1].textContent).toBe('Katovi 2');

        const floorDetail = renderDetail({ selected: 'floor' }).detail;
        expect(descendants(floorDetail).filter(node => node.className.split(' ').includes('viewer-panel'))).toHaveLength(4);
        expect(descendants(floorDetail).find(node => node.tag === 'iframe').src).toBe('https://example.test/floor.pdf#page=4');
    });

    it('foregrounds plan rows without empty building panels when the location is unknown', () => {
        const { detail, viewer } = renderDetail({ located: false });
        const nodes = descendants(detail);
        expect(nodes.filter(node => node.className.split(' ').includes('viewer-panel'))).toHaveLength(0);
        expect(nodes.filter(node => node.className === 'apartment-row')).toHaveLength(1);
        const layout = nodes.find(node => node.className === 'building-detail-layout plans-only');
        expect(layout.children.map(node => node.className)).toEqual(['building-apartment-column']);
        expect(viewer.mountEnvelope).not.toHaveBeenCalled();
        expect(viewer.mountContext).not.toHaveBeenCalled();
    });

    it('keeps available surroundings without an empty outline panel when storeys are missing', () => {
        const { detail, viewer } = renderDetail({ storeys: false });
        expect(descendants(detail).filter(node => node.className.split(' ').includes('viewer-panel')).map(node => node.children[0].textContent)).toEqual(['Kontekst zgrade']);
        expect(viewer.mountEnvelope).not.toHaveBeenCalled();
        expect(viewer.mountContext).toHaveBeenCalledOnce();
    });

    it('builds plural detail links when the payload omits URLs', () => {
        const building = renderDetail({ fallbackPaths: true }).detail;
        const apartmentRow = descendants(building).find(node => node.className === 'apartment-row');
        const floorRow = descendants(building).find(node => node.className.split(' ').includes('floor-plan-row'));
        expect(apartmentRow.children[0].href).toBe('/novogradnje/zgrade/project-a/stanovi/apt-1/');
        expect(floorRow.children[0].href).toBe('/novogradnje/zgrade/project-a/tlocrti/floor-2/');
        const detail = renderDetail({ selected: true, fallbackPaths: true }).detail;
        expect(descendants(detail).some(node => node.href === '/novogradnje/zgrade/project-a/')).toBe(true);
    });

    it('defines desktop two-column panels and a single-column mobile layout', () => {
        expect(css).toMatch(/\.viewer-grid\.apartment-viewer-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
        expect(css).toMatch(/@media\(max-width:760px\)\s*\{[^}]*\.viewer-grid\.apartment-viewer-grid,\.building-detail-layout\s*\{grid-template-columns:minmax\(0,1fr\)/);
        expect(css).toMatch(/\.building-detail-layout\s*\{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
        expect(css).toMatch(/\.building-detail-layout\s*\{[^}]*grid-template-areas:"apartments viewers"/);
        expect(css).toMatch(/@media\(max-width:760px\)[\s\S]*\.building-detail-layout\{grid-template-areas:"viewers" "apartments"\}/);
    });
});
