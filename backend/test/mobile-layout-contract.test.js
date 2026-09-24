// Phone layout rules from the 2026-09-24 mobile review. Each one fixed an overlap that hid a
// control on a ~370px screen: the 3D parcel panel under the mode buttons, a collapsed proposal
// card jumping over the menu button, the drill stack over the Guest pill, and so on. The rules
// live in CSS and wiring, so they are asserted at the source — each assertion fails if its fix
// is reverted.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../frontend/${path}`, import.meta.url), 'utf8');
const mapCss = read('css/map.css');
const utilitiesCss = read('css/utilities.css');
const panelsCss = read('css/panels.css');
const photorealCss = read('css/photoreal-mode.css');
const grainCss = read('css/grain-score.css');
const sidebarCss = read('css/sidebar.css');
const proposalsCss = read('css/proposals.css');
const drillUi = read('js/proposals/drill-ui.js');
const threeMode = read('js/three-mode.js');
const parcelBlocks = read('js/parcel-blocks.js');
const listUi = read('js/proposals/list-ui.js');
const sharingRoutes = read('js/proposals/sharing-routes.js');
const cityPrompt = read('js/city-switch-prompt.js');

// Body of the first `selector { … }` block whose selector text matches, searched from `from`.
function ruleBody(css, selectorPattern, from = 0) {
    const re = new RegExp(`${selectorPattern}\\s*\\{([^{}]*)\\}`, 'g');
    re.lastIndex = from;
    const match = re.exec(css);
    return match ? match[1] : null;
}

// Text of the `@media (…) { … }` block starting at the first occurrence of `query` after `from`.
function mediaBlock(css, query, from = 0) {
    const start = css.indexOf(`@media ${query}`, from);
    if (start < 0) return null;
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
    }
    return null;
}

function mediaBlocksContaining(css, query, needle) {
    const blocks = [];
    let from = 0;
    for (;;) {
        const block = mediaBlock(css, query, from);
        if (!block) break;
        if (block.includes(needle)) blocks.push(block);
        from = css.indexOf(`@media ${query}`, from) + 1;
    }
    return blocks;
}

describe('the lower-left mode strip is never covered on phones', () => {
    it('declares the strip width from the stack offset, on body so it follows the collapsed sidebar', () => {
        const body = ruleBody(mapCss, '(?:^|\\n)body');
        expect(body).toMatch(/--map-mode-strip:\s*calc\(var\(--map-mode-stack-left\)\s*\+\s*50px\)/);
    });

    it('starts the docked bottom sheets right of the strip', () => {
        const [block] = mediaBlocksContaining(utilitiesCss, '(max-width: 768px)', '.info-panel.right-dock-panel');
        expect(block).toBeTruthy();
        expect(ruleBody(block, '\\.info-panel\\.right-dock-panel')).toMatch(/left:\s*var\(--map-mode-strip\)/);
        // With left AND right set, a 100% width would push the sheet off the right edge.
        expect(mediaBlock(panelsCss, '(max-width: 768px)')).toMatch(/--right-dock-width:\s*auto/);
    });

    it('starts the 3D parcel panel right of the strip, not with a gap on the right', () => {
        const [block] = mediaBlocksContaining(mapCss, '(max-width: 768px)', '.three-mode-parcel-panel');
        const body = ruleBody(block, '#three-container \\.three-mode-parcel-panel');
        expect(body).toMatch(/left:\s*var\(--map-mode-strip\)/);
        expect(body).toMatch(/right:\s*12px/);
    });
});

describe('the top row (menu button, Guest pill, gear) belongs to nothing else on phones', () => {
    it('keeps a collapsed proposal card at the bottom: releasing `bottom` is desktop-only', () => {
        const minimizedBase = ruleBody(utilitiesCss, '#proposal-details-panel\\.is-minimized,\\s*#proposal-details-panel\\.visible\\.is-minimized');
        expect(minimizedBase).not.toMatch(/bottom:\s*auto/);
        const [desktop] = mediaBlocksContaining(utilitiesCss, '(min-width: 769px)', '#proposal-details-panel.is-minimized');
        expect(desktop).toMatch(/bottom:\s*auto\s*!important/);
    });

    it('drops the 3D isolation pill to the row below the Guest pill', () => {
        const [block] = mediaBlocksContaining(mapCss, '(max-width: 768px)', '.three-mode-isolation-banner');
        expect(ruleBody(block, '#three-container \\.three-mode-isolation-banner')).toMatch(/top:\s*62px/);
    });

    it('starts the drill stack below the top row, full width, and hides a single-row stack', () => {
        expect(drillUi).toMatch(/const PHONE_TOP_CLEARANCE = 62;/);
        expect(drillUi).toMatch(/let top = isPhoneLayout\(\) \? PHONE_TOP_CLEARANCE : gap;/);
        const [block] = mediaBlocksContaining(mapCss, '(max-width: 768px)', '#drill-stack-panel');
        expect(ruleBody(block, '#drill-stack-panel')).toMatch(/left:\s*10px/);
        expect(block).toMatch(/#drill-stack-panel\.is-single\s*\{\s*display:\s*none;/);
    });

    it('closes the drill stack when neither panel it describes is still open', () => {
        const handler = drillUi.slice(drillUi.indexOf('function onNeighbourChanged()'), drillUi.indexOf('function isPhoneLayout()'));
        expect(handler).toContain("shown('proposal-details-panel')");
        expect(handler).toContain("shown('parcel-info-panel')");
        expect(handler).toContain('hidePanel();');
        expect(drillUi).toMatch(/new MutationObserver\(onNeighbourChanged\)/);
    });
});

describe('3D and photo view', () => {
    it('gives the 3D info panel its own close button, which leaves the isolated view', () => {
        expect(threeMode).toContain('data-role="close-panel"');
        const wiring = threeMode.slice(threeMode.indexOf("querySelector('[data-role=\"close-panel\"]')"));
        expect(wiring.slice(0, 400)).toContain('clearIsolation()');
    });

    it('frames the isolated ground when isolating a parcel or a proposal', () => {
        const parcel = threeMode.slice(threeMode.indexOf('function isolateParcel('), threeMode.indexOf('function frameIsolatedFeatures('));
        expect(parcel).toContain('frameIsolatedFeatures(');
        const proposal = threeMode.slice(threeMode.indexOf('function isolateProposal('), threeMode.indexOf('function clearIsolation('));
        expect(proposal).toContain('frameIsolatedFeatures(feats)');
    });

    it('lifts the view hint clear of the Google attribution, and hides the 2D scale bar', () => {
        expect(photorealCss).toMatch(/#three-container:has\(\.photoreal-attribution\.visible\) \.three-view-hint\s*\{\s*bottom:\s*64px;/);
        expect(mapCss).toMatch(/body\.three-mode-active \.leaflet-control-scale\s*\{\s*display:\s*none;/);
    });
});

describe('block detection on a small screen', () => {
    const run = () => {
        const start = parcelBlocks.indexOf('function selectCurrentBlockIntoMultiSelection(');
        return parcelBlocks.slice(start, parcelBlocks.indexOf('let addedCount = 0;', start));
    };

    it('widens the search, loading ground and road classification before each retry', () => {
        const body = run();
        expect(body).toContain('searchBounds.pad(BLOCK_SEARCH_EXPANSION_PAD)');
        expect(body).toContain('await repository.ensureBounds(searchBounds)');
        expect(body).toContain('await window.fetchCuratedRoadParcels(searchBounds)');
        // The override must not outlive the attempt, or every later viewport query would use it.
        expect(body).toMatch(/blockSearchBoundsOverride = searchBounds;\s*try \{ attempt = flood\(\); \} finally \{ blockSearchBoundsOverride = null; \}/);
    });

    it('checks completeness against the search area, not only the viewport', () => {
        const visible = parcelBlocks.slice(parcelBlocks.indexOf('function isParcelFullyVisible('), parcelBlocks.indexOf('function isBlockComplete('));
        expect(visible).toContain('const bounds = blockSearchBounds();');
        expect(visible).not.toContain('map.getBounds()');
    });
});

describe('smaller fixes', () => {
    it('reports "applied" on a server card from the local copy this browser holds', () => {
        expect(listUi).toMatch(/const appliedSubject = localCopy \|\| proposal;/);
        expect(listUi).toMatch(/isProposalApplied\(appliedSubject\)/);
    });

    it('shows the shared-plan dialog only when there is something to read', () => {
        expect(sharingRoutes).toMatch(/const summaryHasIssues = failed\.length > 0 \|\| rebasedCount > 0;/);
        expect(sharingRoutes).not.toMatch(/&& \(summaryHasIssues \|\| !wants3DFromUrl\)/);
        expect(sharingRoutes).not.toContain("tShare('plan.alreadyAppliedTitle'");
    });

    it('warns when an already-applied link points at proposals deleted from the server', () => {
        expect(sharingRoutes).toContain("tShare('plan.goneFromServer'");
        expect(sharingRoutes).toContain('batchRecords.missing.has(id)');
    });

    it('takes down the loading card before asking which city to open', () => {
        const prompt = cityPrompt.slice(cityPrompt.indexOf('async function promptCityMismatchForProposal'));
        expect(prompt.indexOf('hideProposalLoadOverlay()')).toBeGreaterThan(0);
        expect(prompt.indexOf('hideProposalLoadOverlay()')).toBeLessThan(prompt.indexOf('await askUser('));
    });

    it('keeps the rooster card cream: its selector outranks the generic .btn', () => {
        expect(grainCss).toMatch(/\.btn\.grain-score-button\s*\{/);
        expect(grainCss).toMatch(/\.btn\.grain-score-button:hover:not\(:disabled\)/);
    });

    it('gives <button> accordion headers the same font as the <div> ones', () => {
        expect(ruleBody(sidebarCss, '\\n\\.accordion-header')).toMatch(/font:\s*inherit;/);
    });

    it('lets a proposal title wrap on phones instead of cutting its distinguishing end', () => {
        const [block] = mediaBlocksContaining(proposalsCss, '(max-width: 768px)', '.proposal-card-head');
        expect(ruleBody(block, '\\.proposal-card-head')).toMatch(/flex-wrap:\s*wrap/);
        expect(ruleBody(block, '\\.proposal-list-item--compact \\.proposal-list-title')).toMatch(/white-space:\s*normal/);
    });
});
