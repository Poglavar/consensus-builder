import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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
