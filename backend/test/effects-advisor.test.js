// The Effects section (frontend/js/planning/effects-advisor.js) and its button on a saved plan's Stats
// and analysis page (frontend/js/ui/plan-analysis-controls.js effects): what the section says for an
// assessment, that a superseded design is answered null, and that the plan's buildings reach it.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../../frontend/js/planning/effects-advisor.js', import.meta.url), 'utf8');
const controls = require('../../frontend/js/ui/plan-analysis-controls.js');
const NeighbourEffects = require('../../frontend/js/planning/neighbour-effects.js');

const element = tag => ({ tag, className: '', textContent: '', children: [], dataset: {}, hidden: false, attributes: {},
    append(...nodes) { this.children.push(...nodes); }, prepend(node) { this.children.unshift(node); },
    replaceChildren(...nodes) { this.children = nodes; }, setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    addEventListener(type, handler) { this[`on${type}`] = handler; } });
const textOf = node => typeof node === 'string' ? node : [node.textContent, ...node.children.map(textOf)].join('');
const format = { formatPercent: (v, o) => `${Math.round(o?.ofHundred ? v : v * 100)}%`, formatLength: v => `${Math.round(v)} m`,
    formatNumber: v => String(v), currentLocale: () => 'en-GB' };

function load() {
    const window = { i18n: { t: (key, params = {}) => `${key}(${Object.values(params).join('|')})` }, CbFormat: format, NeighbourEffects };
    new Function('window', 'document', source)(window, { createElement: element });
    return window.NeighbourEffectsAdvisor;
}
const GUIDES = { label: 'Test guides', binding: false, garden: { date: '03-21', hours: 2, share: 0.5, ratio: 0.8 },
    sky: { percent: 27, ratio: 0.8 }, distance: { metres: 21 } };
const AFFECTED = { status: 'affected', estimated: 2, surveys: ['EA LiDAR'], guides: GUIDES, geometries: new Map(), lots: [
    { id: 'a', status: 'fail', direction: 'n', distanceM: 4, garden: { before: 0.8, after: 0.3, status: 'fail' },
        sky: { before: 30, after: 29.9, status: 'same' }, distance: { before: null, after: 12, status: 'fail' } }] };

describe('Effects section', () => {
    it('lists each affected plot with only its changed readings, and the basis', () => {
        const advisor = load();
        const section = element('section');
        advisor.render(section, AFFECTED);
        expect(section.dataset.status).toBe('fail');
        const text = textOf(section);
        expect(text).toContain('neighbourEffects.plot(neighbourEffects.direction.n()|4 m)');
        // The guide's numbers and day come from the place's guides.
        expect(text).toContain('neighbourEffects.garden(2|21 March|80%|30%|50%|0.8)');
        expect(text).toContain('neighbourEffects.distanceNew(12 m|21 m)');
        expect(text).not.toContain('neighbourEffects.sky(');
        expect(text).toContain('neighbourEffects.heightsSurvey(EA LiDAR)');
        expect(text).toContain('neighbourEffects.estimated(2)');
        // Grouped, with what the guides mean a click away, and an icon per changed reading.
        expect(text).toContain('neighbourEffects.groupBeyond(1)');
        expect(text).not.toContain('neighbourEffects.groupWithin');
        expect(text).toContain('neighbourEffects.guidesText(Test guides)');
        expect(text).toContain('neighbourEffects.guidesAdvice');
        const icons = [];
        const walk = node => { if (typeof node !== 'string') { if (node.tag === 'i') icons.push(node.className); node.children.forEach(walk); } };
        walk(section);
        expect(icons.filter(name => name.includes('neighbour-effects__icon--fail'))).toEqual(expect.arrayContaining([
            expect.stringContaining('fa-sun'), expect.stringContaining('fa-left-right')]));
        expect(icons.some(name => name.includes('fa-cloud') && name.includes('--'))).toBe(false);
    });

    it('shows only the plots where one kind of reading changed when its filter is pressed', () => {
        const advisor = load();
        const section = element('section');
        const skyOnly = { ...AFFECTED.lots[0], id: 'b', status: 'worse', garden: null, distance: null, sky: { before: 30, after: 20, status: 'worse' } };
        const result = { ...AFFECTED, lots: [AFFECTED.lots[0], skyOnly] };
        advisor.render(section, result);
        const filters = section.children.find(child => child.className === 'neighbour-effects__filters').children;
        expect(filters.map(textOf)).toEqual(['neighbourEffects.filterAll() (2)', ' neighbourEffects.kind.garden() (1)', ' neighbourEffects.kind.sky() (1)', ' neighbourEffects.kind.distance() (1)']);
        filters[2].onclick();
        const text = textOf(section);
        expect(text).toContain('neighbourEffects.groupWithin(1)');
        expect(text).not.toContain('neighbourEffects.groupBeyond');
        // The filter stays when a new result for the same section arrives.
        advisor.render(section, result);
        expect(textOf(section)).not.toContain('neighbourEffects.groupBeyond');
    });

    it('has no section where the place states no guides, and says when guides bind', () => {
        const advisor = load();
        const section = element('section');
        advisor.render(section, { status: 'notApplicable', lots: [] });
        expect(section.hidden).toBe(true);
        expect(section.children).toEqual([]);
        advisor.render(section, { ...AFFECTED, guides: { ...GUIDES, binding: true } });
        expect(section.hidden).toBe(false);
        expect(textOf(section)).toContain('neighbourEffects.groupBeyondBinding(1)');
        expect(textOf(section)).toContain('neighbourEffects.guidesBinding');
        // Filters only for the readings the guides use.
        // (A place with only a garden guide has only garden readings.)
        const gardenOnly = { ...AFFECTED.lots[0], sky: null, distance: null };
        advisor.render(section, { ...AFFECTED, lots: [gardenOnly], guides: { label: 'Only gardens', garden: GUIDES.garden } }, { kind: null });
        const filters = section.children.find(child => child.className === 'neighbour-effects__filters').children;
        expect(filters.map(textOf)).toEqual(['neighbourEffects.filterAll() (1)', ' neighbourEffects.kind.garden() (1)']);
    });

    it('says when nothing changes, and while measuring', () => {
        const advisor = load();
        const section = element('section');
        advisor.render(section, null);
        expect(textOf(section)).toContain('neighbourEffects.measuring');
        // A spinner in the heading while measuring, gone once the result is in.
        expect(section.children[0].className).toContain('cb-busy');
        expect(section.attributes['aria-busy']).toBe('true');
        advisor.render(section, { status: 'clear', lots: [], surveys: [], estimated: 0 });
        expect(textOf(section)).toContain('neighbourEffects.clear');
        expect(section.children[0].className).not.toContain('cb-busy');
        expect(section.attributes['aria-busy']).toBeUndefined();
        expect(section.hidden).toBe(false);
        advisor.render(section, { status: 'none', lots: [] });
        expect(textOf(section)).toContain('neighbourEffects.noBuildings');
        expect(section.hidden).toBe(false);
    });
});

describe('Plots in the list point at the map', () => {
    // A geoJSON layer stand-in: one path per feature, its element's classes and the view it pans.
    function withMap(advisor, window) {
        const paths = [];
        window.L = { geoJSON: data => ({
            addTo() { return this; }, remove() {},
            eachLayer(visit) {
                for (const feature of data.features) {
                    const classes = new Set();
                    const path = { feature, bringToFront: vi.fn(), getBounds: () => ({ getCenter: () => feature.properties.id }),
                        getElement: () => ({ classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: name => classes.has(name) } }) };
                    path.lit = () => classes.has('neighbour-effect--focus');
                    paths.push(path);
                    visit(path);
                }
            } }) };
        const map = { panTo: vi.fn(), getBounds: () => ({ contains: () => false }) };
        return { paths, map };
    }
    function loadWithWindow() {
        const window = { i18n: { t: (key, params = {}) => `${key}(${Object.values(params).join('|')})` }, CbFormat: format, NeighbourEffects };
        new Function('window', 'document', source)(window, { createElement: element });
        return { advisor: window.NeighbourEffectsAdvisor, window };
    }
    const TWO = { ...AFFECTED, geometries: new Map([['a', { type: 'Polygon' }], ['b', { type: 'Polygon' }]]),
        lots: [AFFECTED.lots[0], { ...AFFECTED.lots[0], id: 'b', direction: 's' }] };

    it('highlights a plot while its name is hovered, and keeps it on a click', () => {
        const { advisor, window } = loadWithWindow();
        const { paths, map } = withMap(advisor, window);
        const section = element('section');
        section.querySelectorAll = () => names;
        advisor.render(section, TWO);
        advisor.show(map, TWO);
        const items = section.children.find(child => child.tag === 'ul').children;
        const names = items.map(item => item.children[0]);
        expect(names.map(name => name.tag)).toEqual(['button', 'button']);
        const [a, b] = paths;
        names[1].onmouseenter();
        expect(b.lit()).toBe(true);
        expect(a.lit()).toBe(false);
        // The 3D view reads the same plots, the pointed-at one marked.
        expect(advisor.plots().map(plot => [plot.id, plot.focus])).toEqual([['a', false], ['b', true]]);
        names[1].onmouseleave();
        expect(b.lit()).toBe(false);
        names[0].onclick();
        names[0].onmouseleave();
        expect(a.lit()).toBe(true);
        expect(names[0].attributes['aria-pressed']).toBe('true');
        expect(map.panTo).toHaveBeenCalledWith('a');
        names[0].onclick();
        expect(a.lit()).toBe(false);
        expect(advisor.plots().some(plot => plot.focus)).toBe(false);
        advisor.clear();
        expect(advisor.plots()).toEqual([]);
    });
});

describe('Effects on a saved plan', () => {
    it("assesses the plan's new buildings and shows the result in the section and on the map", async () => {
        const records = [{ proposalId: 'p1' }];
        const buildings = [{ id: 'p1#0', footprint: {}, heightM: 20 }];
        const advisor = { render: vi.fn(), show: vi.fn(), assess: vi.fn((design, answer) => answer(AFFECTED)) };
        const win = { i18n: { t: key => key }, map: { id: 'map' }, NeighbourEffectsAdvisor: advisor,
            BusyControl: { isBusy: () => false, track: (_el, run) => run() }, showStyledAlert: vi.fn(),
            PlanAnalysis: { prepare: vi.fn(async () => ({ records })) },
            __planDecision: { permittedBuildings: vi.fn(() => buildings) } };
        const wrapper = controls.effects(win, { createElement: element }, async () => ({ cid: 'plan' }));
        const [button, section] = wrapper.children;
        button.onclick();
        await vi.waitFor(() => expect(advisor.show).toHaveBeenCalled());
        expect(win.__planDecision.permittedBuildings).toHaveBeenCalledWith(records);
        expect(advisor.assess.mock.calls[0][0]).toEqual({ buildings });
        expect(advisor.render).toHaveBeenLastCalledWith(section, AFFECTED);
        expect(advisor.show).toHaveBeenCalledWith(win.map, AFFECTED);
    });
});
