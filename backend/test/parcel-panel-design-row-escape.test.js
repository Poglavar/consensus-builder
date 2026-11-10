// A published design's title and author are free text from anyone: the parcel panel's design rows must render them as text, never as markup.
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const panelSource = readFileSync(new URL('../../frontend/js/parcels/ui/parcel-panel.js', import.meta.url), 'utf8');
const sharedUtilsSource = readFileSync(new URL('../../frontend/js/shared-utils.js', import.meta.url), 'utf8');
const setProposalsSource = readFileSync(new URL('../../frontend/js/parcels/parcel-set-proposals.js', import.meta.url), 'utf8');

// The row builder is the `parcelProposals.map(proposal => { ... })` callback inside showParcelInfoPanel.
function rowBuilder() {
    const start = panelSource.indexOf('parcelProposals.map(proposal => {');
    const end = panelSource.indexOf('}).join(\'\');', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const callback = panelSource.slice(start + 'parcelProposals.map('.length, end + 1);
    const scope = { console };
    scope.window = scope;
    scope.global = scope;
    const context = vm.createContext(scope);
    vm.runInContext(sharedUtilsSource, context);
    vm.runInContext(setProposalsSource, context);
    Object.assign(scope, {
        tParcel: (_key, _params, fallback) => fallback,
        RecordLabel: { label: (title, id) => `${title} ${id}`, shortId: id => String(id).slice(0, 6) },
        proposalLadderBadgesHtml: () => '',
        parcelProposals: [],
        feature: { properties: {} },
        parcelId: 'p1',
        recordIds: [],
        proposalRoadSuffix: '',
        proposalAuthorLabel: 'Author:',
        proposalUnknownAuthor: 'Unknown',
        proposalFallbackTitle: 'Design',
        proposalRecordId: proposal => proposal.proposalId,
        proposalRecordBadgeHtml: () => ''
    });
    return vm.runInContext(`(${callback})`, context);
}

it('escapes a published design title and author in the parcel panel design list', () => {
    const html = rowBuilder()({
        proposalId: 'design-1',
        goal: 'buildings',
        title: '<img src=x onerror="alert(1)">',
        author: '<script>steal()</script>'
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('&lt;script&gt;steal()&lt;/script&gt;');
});
