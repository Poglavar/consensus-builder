// The Permitted check's existing context (frontend/js/planning/permitted-advisor.js) always stands on
// the best height measure available: a height survey's measurement replaces the building source's
// height whatever Built → Heights shows, and the result names the survey it used.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const ruleTerms = require('../../frontend/js/planning/rule-terms.js');
const survey = require('../../frontend/js/buildings/height-survey.js');
const source = readFileSync(new URL('../../frontend/js/planning/permitted-advisor.js', import.meta.url), 'utf8');

const square = (x, y, d) => ({ type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
const LOT = square(-0.1073, 51.5449, 0.0003);
const HOUSE = { type: 'Feature', id: 'way/1', properties: { id: 'way/1', height_m: null, floors: 2 }, geometry: square(-0.1072, 51.5450, 0.0001) };
const DESIGN = { buildings: [{ id: 'b1', footprint: { type: 'Feature', properties: {}, geometry: square(-0.10715, 51.54505, 0.00003) } }] };
const MEASURED = { heightM: 9.16, eaveM: 8.46, confidence: 'high', survey: { id: 'gb-ea', name: 'EA LiDAR' } };

// A fake element tree, enough for render(): tag, class, text and children.
const element = tag => ({ tag, className: '', textContent: '', children: [], dataset: {},
    append(...nodes) { this.children.push(...nodes); }, replaceChildren() { this.children = []; } });
const textOf = node => typeof node === 'string' ? node : [node.textContent, ...node.children.map(textOf)].join('');

function advisor(heights) {
    const client = { usesSurvey: () => heights === 'survey',
        fillHeights: vi.fn(async records => records.map(record => record.id === 'way/1' ? survey.withMeasuredHeight(record, MEASURED) : record)) };
    const window = {
        turf, PlanningRuleTerms: ruleTerms, HeightSurveyClient: client, buildingFeaturePool: [HOUSE],
        PlanningScene: { createViewportCache: () => ({}) },
        LiveParcelFabric: { peekBounds: () => [{ properties: { parcelId: 'lot-1' }, geometry: LOT }] },
        StreetFrontage: { streetsNear: async () => ({ streets: [] }) },
        PlanningStreetWidth: { streetSetting: () => ({ street: null, neighbours: [] }) },
        PermittedCheck: { summarize: () => [] },
        i18n: { t: (key, params = {}) => `${key}(${Object.values(params).join('|')})` }
    };
    // Same realm as turf (a vm context would hand turf foreign arrays).
    const document = { createElement: element };
    new Function('window', 'document', source)(window, document);
    return { api: window.PermittedAdvisor, client };
}

describe('Permitted check heights', () => {
    for (const heights of ['survey', 'source']) {
        it(`uses the survey's height for the existing building with Built → Heights on ${heights}`, async () => {
            const { api, client } = advisor(heights);
            const context = await api.existingContextFor(DESIGN);
            expect(client.fillHeights).toHaveBeenCalledTimes(1);
            // 2 storeys would be 6 m; the survey measured 9.16 m.
            expect(context.heightM).toBeCloseTo(9.16, 2);
            expect(context.buildings[0]).toMatchObject({ source: 'measured', survey: { name: 'EA LiDAR' } });
        });
    }

    it('names the height survey under the result', () => {
        const { api } = advisor('source');
        const container = element('section');
        api.render(container, { status: 'pass', checks: [], source: { label: 'London Plan' }, heightSurveys: ['EA LiDAR'] });
        const lines = container.children.map(textOf);
        expect(lines).toContain('permittedCheck.heightsSource(EA LiDAR)');
        const none = element('section');
        api.render(none, { status: 'pass', checks: [], source: { label: 'London Plan' }, heightSurveys: [] });
        expect(none.children.map(textOf).some(text => text.startsWith('permittedCheck.heightsSource'))).toBe(false);
    });
});
