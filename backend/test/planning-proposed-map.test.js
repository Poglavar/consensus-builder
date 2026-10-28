// The map must use the same proposed representation and variation as the model, without changing source features.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const source = readFileSync(new URL('../../frontend/js/building-blocks.js', import.meta.url), 'utf8');
const start = source.indexOf('function drawProposedBuildingsForProposal(');
const draw = source.slice(start, source.indexOf('\nfunction ', start + 10));
function render(form, fail = false) {
    const building = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { proposalId: 'p' } };
    const buildOut = { ...building, properties: { ...building.properties, realized: true } };
    const list = [building], rendered = [], turf = {};
    const planner = vi.fn(() => {
        if (fail) throw new Error('Invalid rule geometry');
        return { massing: form === 'buildout' ? null : building,
            buildOut: form === 'massing' ? null : buildOut, massingStyle: form === 'both' ? 'envelope' : 'primary' };
    });
    const context = {
        map: {}, turf, proposedBuildingLayer: {}, proposedBuildingSublayers: new Map(),
        proposedBuildingKey: String, ensureProposedBuildingLayer() {}, appliedIneligibleBlockParts: () => [],
        ensureProposedBuildingsState: () => list, proposedBuildingCanvas: () => 'canvas',
        PROPOSED_BUILDING_STYLE: { fillOpacity: 0.35 }, console: { error: vi.fn() },
        translateBuildingText: (_key, text) => text, showErrorPopup: vi.fn(),
        L: { featureGroup: () => ({ addTo() {} }), geoJSON: (feature, options) => ({ addTo() { rendered.push({ feature, options }); } }) },
        window: { PlanningViews: { getState: () => ({ proposedForm: form, proposedVariation: '7' }), color: () => '#c26336' },
            UrbanRuleVariation: { plannedDrawPlan: planner } }
    };
    vm.runInNewContext(draw, context);
    context.drawProposedBuildingsForProposal('p', { announce: false });
    return { building, buildOut, list, rendered, planner, turf };
}
describe('shared proposed map representation', () => {
    it.each(['massing', 'buildout', 'both'])('renders %s with the shared variation and original source intact', form => {
        const result = render(form);
        expect(result.planner).toHaveBeenCalledWith(result.building, form, { turf: result.turf }, '7');
        expect(result.rendered.map(entry => entry.feature)).toEqual(form === 'massing' ? [result.building] : form === 'buildout' ? [result.buildOut] : [result.building, result.buildOut]);
        expect(result.list).toEqual([result.building]);
        expect(result.rendered.map(entry => entry.options.style.fillOpacity)).toEqual(form === 'both' ? [0.12, 1] : [1]);
        expect(result.rendered.every(entry => entry.options.pane === 'proposedBuildingsPane' && !entry.options.interactive)).toBe(true);
    });
    it('does not delete source geometry when representation generation fails', () => {
        const result = render('buildout', true);
        expect(result.rendered).toEqual([]); expect(result.list).toEqual([result.building]);
    });
});
