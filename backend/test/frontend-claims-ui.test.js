import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeDocument, makeEvent } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);

for (const live of [true, false]) {
    it(`a ${live ? 'live' : 'consumed'} ownership anchor takes over the dock before opening its parcel`, () => {
        const calls = [];
        const feature = { type: 'Feature', properties: { parcelId: 'fixture-ground' }, geometry: { type: 'Polygon', coordinates: [] } };
        const window = {
            hideProposalDetailsPanel: () => calls.push('close proposal'),
            LiveParcelFabric: { get: () => live ? feature : null },
            CadastralParcelRepository: { get: () => feature },
            selectParcel: id => calls.push(['select', id]),
            showParcelInfoPanel: value => calls.push(['dossier', value]),
        };
        const context = vm.createContext({ window, document: { readyState: 'loading', addEventListener() {}, getElementById: () => null } });
        vm.runInContext(readFileSync(new URL('../../frontend/js/proposals/claims-ui.js', import.meta.url), 'utf8'), context);
        window.__claimsUi.openBaseParcel('fixture-ground');
        expect(calls).toEqual(['close proposal', live ? ['select', 'fixture-ground'] : ['dossier', feature]]);
    });
}

// The breadcrumb's parcels are an object list (docs/design-language.md, "Object lists"): hovering a
// parcel outlines its cadastral shape (also once a design consumed it), a click keeps it outlined
// and never opens it, and only its arrow opens the parcel.
it('the breadcrumb outlines a parcel on hover and click, and opens it by its arrow', () => {
    const calls = [];
    const feature = { type: 'Feature', properties: { parcelId: 'fixture-ground' }, geometry: { type: 'Polygon', coordinates: [] } };
    const document = makeDocument();
    document.readyState = 'loading';
    const window = {
        ObjectList: require('../../frontend/js/ui/object-list.js'),
        ParcelSetProposals: require('../../frontend/js/parcels/parcel-set-proposals.js'),
        __claims: { cadastreParcelIdsOf: () => ['fixture-ground'], shortParcelLabel: () => '1234' },
        hideProposalDetailsPanel: () => calls.push('close proposal'),
        LiveParcelFabric: { get: () => null },
        CadastralParcelRepository: { get: id => (id === 'fixture-ground' ? feature : null) },
        showParcelInfoPanel: value => calls.push(['dossier', value.properties.parcelId]),
        highlightFeaturesForHover: features => calls.push(['hover', features.length]),
        highlightFeaturesForInspection: features => calls.push(['inspect', features.length]),
        clearProposalHoverLayers: () => calls.push('clear'),
        ClickStack: { holdsHighlight: () => true, restoreFocus: () => calls.push('restore focus') }
    };
    const context = vm.createContext({ window, document });
    vm.runInContext(readFileSync(new URL('../../frontend/js/proposals/claims-ui.js', import.meta.url), 'utf8'), context);
    const section = document.createElement('div');
    document.body.appendChild(section);
    window.__claimsUi.injectProposalBreadcrumb(section, { proposalId: 'p' });
    const item = section.querySelector('.claim-breadcrumb-item');
    const name = item.querySelector('.claim-breadcrumb-link');
    const open = item.querySelector('.claim-breadcrumb-open');
    expect(name.textContent).toBe('1234');
    expect(open.getAttribute('aria-label')).toBe('Open 1234');

    item.dispatchEvent(makeEvent('mouseover', { target: name, relatedTarget: null }));
    item.dispatchEvent(makeEvent('mouseout', { target: name, relatedTarget: null }));
    name.click();
    expect(name.getAttribute('aria-pressed')).toBe('true');
    name.click();
    expect(name.getAttribute('aria-pressed')).toBe('false');
    expect(calls).toEqual([['hover', 1], 'clear', 'clear', ['inspect', 1], 'clear', 'restore focus']);

    calls.length = 0;
    open.click();
    expect(calls).toEqual(['close proposal', ['dossier', 'fixture-ground']]);
});
