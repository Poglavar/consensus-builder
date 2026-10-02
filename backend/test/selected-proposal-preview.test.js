import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/proposals/layer-render.js', import.meta.url), 'utf8');
function setup(applied) {
    const layers = [];
    const group = { clearLayers() {}, bringToFront() {}, __paneName: 'proposalHighlightPane' };
    const env = {
        console, performance, document: { getElementById: () => null }, setProposalDetailsPanelMinimized: vi.fn(), proposalHighlightStyleOverride: { restoreAll() {} },
        collectProposalFeatureSets: () => ({ primaryFeatures: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } }] }),
        resolveProposalGoalKey: () => 'park', isApplied: () => applied,
        collectProposalSelectionParcelIds: () => new Set(), forEachProposalParcelInViewport() {},
        getProposalKey: p => p.proposalId, focusProposalDetails: vi.fn(),
        L: { DomEvent: { stopPropagation: vi.fn() }, geoJSON: vi.fn((feature, options) => {
            const layer = { options, on: vi.fn((type, fn) => { layer.click = fn; }), addTo() {} };
            layers.push(layer); return layer;
        }) }
    };
    env.window = env;
    vm.runInNewContext(source, env);
    env.ensureProposalOverlayGroups = () => ({ border: group });
    return { env, layers };
}
describe('selected unapplied proposal hit surface', () => {
    it('makes the preview geometry clickable without materializing it or moving the camera', () => {
        const { env, layers } = setup(false);
        env.renderAppliedProposalHighlight({ proposalId: 'preview' });
        expect(layers[0].options.interactive).toBe(true);
        expect(layers[0].options.style().fillOpacity).toBe(0);
        layers[0].click({ originalEvent: {} });
        expect(env.focusProposalDetails).toHaveBeenCalledWith('preview', { centerOnProposal: false, showDetails: true });
        expect(env.L.DomEvent.stopPropagation).toHaveBeenCalledOnce();
    });
    it('keeps applied highlights passive so live fabric remains the click authority', () => {
        const { env, layers } = setup(true);
        env.renderAppliedProposalHighlight({ proposalId: 'applied' });
        expect(layers[0].options.interactive).toBe(false);
        expect(layers[0].on).not.toHaveBeenCalled();
    });
    it('keeps already-open details unchanged on a second click inside the preview', () => {
        const { env, layers } = setup(false);
        env.document.getElementById = () => ({ classList: { contains: () => true } });
        env.renderAppliedProposalHighlight({ proposalId: 'preview' }); layers[0].click({});
        expect(env.focusProposalDetails).not.toHaveBeenCalled();
        expect(env.L.DomEvent.stopPropagation).toHaveBeenCalledOnce();
    });
    it('lets map editing tools receive clicks instead of selecting the preview', () => {
        const { env, layers } = setup(false);
        env.renderAppliedProposalHighlight({ proposalId: 'preview' });
        env.isParcelDrawingModeActive = () => true;
        layers[0].click({});
        expect(env.focusProposalDetails).not.toHaveBeenCalled();
        expect(env.L.DomEvent.stopPropagation).not.toHaveBeenCalled();
    });
});
