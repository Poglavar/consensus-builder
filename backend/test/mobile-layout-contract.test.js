// Phone layout rules from the 2026-09-24 mobile review. Each one fixed an overlap that hid a
// control on a ~370px screen: the 3D parcel panel under the mode buttons, a collapsed proposal
// card jumping over the menu button, the stack panel over the Guest pill, and so on. The rules
// live in CSS and wiring, so they are asserted at the source — each assertion fails if its fix
// is reverted.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../frontend/${path}`, import.meta.url), 'utf8');
const mapCss = read('css/map.css');
const utilitiesCss = read('css/utilities.css');
const panelsCss = read('css/panels.css');
const photorealCss = read('css/photoreal-mode.css');
const grainCss = read('css/grain-score.css');
const mapShellCss = read('css/map-shell.css');
const primitivesCss = read('css/primitives.css');
const indexHtml = read('index.html');
const mapCreditsCss = read('css/map-credits.css');
const proposalsCss = read('css/proposals.css');
const proposalDetailsCss = read('css/proposal-details.css');
const clickStackPanel = read('js/click-stack/click-stack-panel.js');
const dockSheet = read('js/mobile-dock-sheet.js');
const threeMode = read('js/three-mode.js');
const parcelBlocks = read('js/parcel-blocks.js');
const listUi = read('js/proposals/list-ui.js');
const cityPrompt = read('js/city-switch-prompt.js');

describe('parcel selection presentation', () => {
    it('has no retired tray markup or stylesheet', () => {
        expect(indexHtml).not.toMatch(/selection-tray(?:-slot)?/);
        expect(existsSync(new URL('../../frontend/css/selection-tray.css', import.meta.url))).toBe(false);
        expect([mapCss, utilitiesCss, panelsCss, mapShellCss, proposalsCss].join('\n'))
            .not.toMatch(/(?:#|\.)selection-tray\b/);
    });
});

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

describe('the left-edge mode strip is never covered on phones', () => {
    it('declares the strip width from the stack offset, on body where the offset is in scope', () => {
        const body = ruleBody(mapCss, '(?:^|\\n)body');
        expect(body).toMatch(/--map-mode-strip:\s*calc\(var\(--map-mode-stack-left\)\s*\+\s*50px\)/);
    });

    // The strip moved to the top-left under the search box, so a half-height sheet no longer
    // reaches it; the sheets run edge to edge (docs/design-language.md: full-width sheets on phones).
    it('runs the docked bottom sheets edge to edge', () => {
        const [block] = mediaBlocksContaining(utilitiesCss, '(max-width: 767.98px)', '.info-panel.right-dock-panel');
        expect(block).toBeTruthy();
        expect(ruleBody(block, '\\.info-panel\\.right-dock-panel:not\\(#proposal-details-panel\\)')).toContain('left: var(--info-panel-mobile-inset, 0) !important;');
        // With left AND right set, a 100% width would push the sheet off the right edge.
        expect(mediaBlock(panelsCss, '(max-width: 767.98px)')).toMatch(/--right-dock-width:\s*auto/);
    });

    // 2026-10-16: the strip hangs from the top-left under the search box on phones, so every bottom
    // sheet runs edge to edge and the strip is always in the upper third of the screen.
    it('hangs the mode strip from the top clearance on phones, and nothing lifts it from below', () => {
        const [block] = mediaBlocksContaining(mapCss, '(max-width: 767.98px)', '--map-mode-stack-bottom');
        expect(ruleBody(block, '(?:^|\\n)\\s*body')).toMatch(/--map-mode-stack-bottom:\s*calc\(var\(--map-shell-top-clearance\)\s*\+\s*276px\)/);
        expect(mapShellCss).not.toContain('--info-panel-mobile-inset: var(--map-mode-strip)');
    });

    it('makes the road panel the full-width bottom block on the screen edge, at most half the screen', () => {
        const [block] = mediaBlocksContaining(panelsCss, '(max-width: 767.98px)', '#map-container #road-info-panel');
        const body = ruleBody(block, '#map-container #road-info-panel');
        expect(body).toMatch(/bottom:\s*0;/);
        expect(body).toMatch(/height:\s*auto/);
        expect(body).toMatch(/max-height:\s*50dvh/);
        expect(panelsCss + mapShellCss).not.toContain('--map-editor-toolbar-height');
        expect(ruleBody(block, '#road-info-panel \\.mobile-dock-sheet-handle')).toMatch(/display:\s*none/);
    });

    it('puts the road tools in one row under the panel header, not in it', () => {
        const header = indexHtml.slice(indexHtml.indexOf('<div class="road-panel-header">'), indexHtml.indexOf('<div class="cb-actions road-panel-tools">'));
        expect(header).not.toContain('editRoadCrossSectionButton');
        expect(header).not.toContain('importRoadsButton');
        const tools = indexHtml.slice(indexHtml.indexOf('<div class="cb-actions road-panel-tools">'), indexHtml.indexOf('<div class="road-metrics-grid">'));
        expect(tools).toContain('id="editRoadCrossSectionButton"');
        expect(tools).toContain('id="importRoadsButton"');
        expect(ruleBody(panelsCss, '#road-info-panel \\.road-panel-tools \\.btn')).toMatch(/flex:\s*1 1 0/);
        // the desktop panel fits its content
        expect(ruleBody(panelsCss, '(?:^|\\n)#road-info-panel')).toMatch(/height:\s*auto/);
    });

    it('keeps every road metric box two lines tall, puts Undo / Finish / Cancel in the road panel as equal parts of its last row, and shows the map through phone panels', () => {
        expect(ruleBody(utilitiesCss, '\\.road-metrics-grid \\.metric-group')).toMatch(/min-height:\s*calc\(2 \* 1\.3em \+ 18px\)/);
        const panel = indexHtml.slice(indexHtml.indexOf('<div id="road-info-panel"'), indexHtml.indexOf('<div id="road-analysis-panel"'));
        const controls = panel.indexOf('id="road-drawing-controls"');
        expect(controls).toBeGreaterThan(panel.indexOf('<div class="road-metrics-grid">'));
        expect(panel.slice(controls)).toMatch(/id="undoRoadButton"[\s\S]*id="finishRoadButton"[\s\S]*cancelRoadOrTrackDrawing/);
        expect(indexHtml.match(/id="road-drawing-controls"/g)).toHaveLength(1);
        expect(panel).not.toMatch(/id="road-drawing-controls"[^>]*map-editor-toolbar/);
        expect(ruleBody(panelsCss, '#road-drawing-controls > \\.cb-actions > \\.btn')).toMatch(/flex:\s*1 1 0/);
        // the metrics scroll, the controls row does not
        expect(ruleBody(panelsCss, '#road-info-panel > \\.road-metrics-grid')).toMatch(/overflow-y:\s*auto/);
        expect(ruleBody(panelsCss, '#road-info-panel\\.visible')).toMatch(/flex-direction:\s*column/);
        // The map shows through every panel, on phones as on desktop (one rule per panel, no phone override).
        expect(ruleBody(panelsCss, '(?:^|\\n)\\.info-panel')).toMatch(/background:\s*var\(--cb-glass-sheet\)/);
        expect(ruleBody(mapShellCss, '(?:^|\\n)\\.map-sheet')).toMatch(/background:\s*var\(--cb-glass-sheet\)/);
        const tokens = read('css/tokens.css');
        expect(tokens.match(/--cb-glass-sheet:/g)).toHaveLength(2);
        const [panelBlock] = mediaBlocksContaining(panelsCss, '(max-width: 767.98px)', '#road-info-panel .road-panel-actions .close-circle-btn--lg');
        expect(ruleBody(panelBlock, '#road-info-panel \\.road-panel-actions \\.close-circle-btn--lg')).toMatch(/height:\s*34px/);
        expect(indexHtml).toMatch(/data-i18n-key="panel\.road\.finishButtonShort">Finish<\/button>/);
    });

    it('docks the compact proposal card on the bar as a glass sheet with a short centred header', () => {
        const [block] = mediaBlocksContaining(proposalDetailsCss, '(max-width: 767.98px)', '#proposal-details-panel.right-dock-panel.is-minimized');
        const card = ruleBody(block, '#proposal-details-panel\\.right-dock-panel\\.is-minimized');
        expect(card).toMatch(/inset:\s*auto 0 var\(--map-visible-bottom\) 0/);
        expect(card).toMatch(/background:\s*var\(--cb-glass-sheet\)/);
        expect(ruleBody(block, '#proposal-details-panel\\.is-minimized \\.panel-header')).toMatch(/align-items:\s*center/);
        // every button has a border or a colour: the quiet role is outlined with the faint line
        expect(ruleBody(primitivesCss, '\\.btn-quiet')).toMatch(/border-color:\s*var\(--cb-line\)/);
        expect(ruleBody(primitivesCss, '\\.btn-quiet')).not.toMatch(/border-color:\s*transparent/);
    });

    it('keeps the credits in the map on the open sheet, one size smaller', () => {
        const [block] = mediaBlocksContaining(mapShellCss, '(max-width: 767.98px)', '#map-container .leaflet-bottom');
        expect(ruleBody(block, '#map-container \\.leaflet-bottom')).toMatch(/bottom:\s*var\(--map-sheet-occupied, var\(--map-visible-bottom\)\)/);
        expect(ruleBody(block, '\\.map-credits-control')).toMatch(/font-size:\s*var\(--cb-text-xs\)/);
    });

    it('shows the avatar alone on phones with a ring that says whether a wallet is connected', () => {
        const [block] = mediaBlocksContaining(mapShellCss, '(max-width: 767.98px)', '[data-wallet="connected"]');
        expect(ruleBody(block, '#map-container \\.username-display \\.user-avatar')).toMatch(/border:\s*2px dashed/);
        expect(ruleBody(block, '#map-container \\.username-display\\[data-wallet="connected"\\] \\.user-avatar')).toMatch(/border:\s*2px solid var\(--cb-success\)/);
        expect(ruleBody(block, '#map-container \\.username-display \\.wallet-status-icon')).toMatch(/display:\s*none/);
        expect(ruleBody(block, '#map-container #username-text')).toMatch(/clip-path/);
    });

    // The 3D view's figures live in its click stack, which shares the 2D stack's frame: no panel or
    // header, only the section cards over the scene; nothing floats top-left any more.
    it('gives the 3D click stack the 2D stack frame instead of a floating 3D parcel panel', () => {
        expect(ruleBody(mapCss, '#click-stack,\\s*#three-click-stack')).toMatch(/pointer-events:\s*none/);
        const stackJs = read('js/three-click-stack.js');
        expect(stackJs).toContain("el.className = 'click-stack right-dock-panel'");
        expect(stackJs).not.toContain("'click-stack__head'");
        expect(mapCss).not.toMatch(/\.three-mode-parcel-panel\s*\{[^}]*position:\s*absolute/);
    });
});

describe('proposal details and compact card on phones', () => {
    it('allows a compact proposal card as well as a full-screen details reader', () => {
        const [mobile] = mediaBlocksContaining(proposalDetailsCss, '(max-width: 767.98px)', '#proposal-details-panel.right-dock-panel');
        const reader = ruleBody(mobile, '#proposal-details-panel\\.right-dock-panel:not\\(\\.is-minimized\\)');
        expect(reader).toMatch(/inset:\s*0/);
        expect(reader).toMatch(/height:\s*100dvh/);
        expect(mobile).toContain('#proposal-details-panel.right-dock-panel.is-minimized');
        expect(mobile).toMatch(/inset:\s*auto\s+0\s+var\(--map-visible-bottom\)\s+0/);
        expect(mobile).not.toMatch(/\.proposal-details-toggle[^}]*display:\s*none/);
        const [desktop] = mediaBlocksContaining(utilitiesCss, '(min-width: 768px)', '#proposal-details-panel.is-minimized');
        expect(desktop).toMatch(/bottom:\s*auto\s*!important/);
    });

    it('drops the 3D isolation pill to the row below the Guest pill', () => {
        const [block] = mediaBlocksContaining(mapCss, '(max-width: 767.98px)', '.three-mode-isolation-banner');
        expect(ruleBody(block, '#three-container \\.three-mode-isolation-banner')).toMatch(/top:\s*62px/);
    });

    // The drill stack's own phone geometry (a full-width top-row card) went with it. The click stack
    // (2D and 3D alike) is no panel and no sheet: an invisible full-width column whose section cards
    // float over the map, so the dock sheet (.info-panel) never wires it; a panel it hosts is part of
    // its card and must not become a sheet with a handle either.
    it('keeps the click stacks out of the phone dock sheet, their cards floating over the map', () => {
        expect(clickStackPanel).toContain("el.className = 'click-stack right-dock-panel';");
        expect(read('js/three-click-stack.js')).toContain("el.className = 'click-stack right-dock-panel';");
        expect(dockSheet).toContain("const PANEL_SELECTOR = '.info-panel.right-dock-panel:not(#proposal-details-panel):not(.is-hosted)';");
        const [phone] = mediaBlocksContaining(mapCss, '(max-width: 767.98px)', '#three-click-stack');
        const column = ruleBody(phone, '#click-stack,\\s*#three-click-stack');
        expect(column).toMatch(/left:\s*0/);
        expect(column).toMatch(/right:\s*0/);
        expect(ruleBody(mapCss, '#click-stack \\.is-hosted \\.mobile-dock-sheet-handle')).toMatch(/display:\s*none/);
        expect(mapCss).not.toContain('#drill-stack-panel');
    });

    it('takes a hosted panel out of the dock: no position, size or frame of its own', () => {
        // Whatever the selector spelling (the panels' own id rules have to be outweighed).
        const hosted = [...mapCss.matchAll(/#click-stack[^{}]*\.is-hosted[^{}]*\{([^{}]*)\}/g)]
            .map(match => match[1]).find(body => /position:\s*static/.test(body)) || '';
        expect(hosted).toMatch(/position:\s*static/);
        expect(hosted).toMatch(/max-height:\s*none/);
        expect(hosted).toMatch(/box-shadow:\s*none/);
    });
});

describe('3D and photo view', () => {
    it('closes the isolated view with the 3D click stack, and the stack with the view', () => {
        const end = threeMode.slice(threeMode.indexOf('function endSelectionView('), threeMode.indexOf('let stackDriving'));
        expect(end).toContain('ThreeClickStack?.close({ silent: true })');
        expect(end).toContain('clearIsolation()');
        const closed = threeMode.slice(threeMode.indexOf('        closed() {'), threeMode.indexOf('        closed() {') + 160);
        expect(closed).toContain('endSelectionView()');
    });

    it('keeps parcel selection in place while explicit proposal isolation frames its ground', () => {
        const parcel = threeMode.slice(threeMode.indexOf('function isolateParcel('), threeMode.indexOf('function frameIsolatedFeatures('));
        expect(parcel).not.toContain('frameIsolatedFeatures(');
        expect(parcel).not.toContain('applyIsolationVisibility(');
        const proposal = threeMode.slice(threeMode.indexOf('function isolateProposal('), threeMode.indexOf('function clearIsolation('));
        expect(proposal).toContain('frameIsolatedFeatures(feats)');
    });

    it('sets the credits and the scale bar straight on the map, in the one row above the dock', () => {
        // Neither corner control is lifted or boxed: both Leaflet corners already sit at --map-visible-bottom.
        expect(ruleBody(mapCss, '\\.leaflet-bottom\\.leaflet-right \\.leaflet-control-scale')).toBeNull();
        expect(ruleBody(mapCss, '\\.leaflet-control-scale-line')).toMatch(/background:\s*transparent/);
        expect(ruleBody(mapCreditsCss, '\\.map-credits-control')).toMatch(/background:\s*transparent/);
        // On a phone the dock is a veil whose buttons at rest do not hide it; on a wide map it is
        // three pills on the bottom edge, with no band across the map.
        const phone = mediaBlock(mapShellCss, '(max-width: 767.98px)', mapShellCss.indexOf('Phones: bottom sheets'));
        expect(ruleBody(phone, '\\.map-shell-cluster--bottom-right')).toMatch(/background:\s*var\(--cb-glass-veil\)/);
        expect(ruleBody(phone, '\\.map-shell-cluster--bottom-right \\.map-shell-button--labelled')).toMatch(/background:\s*transparent/);
        expect(ruleBody(mapShellCss, '\\.map-shell-cluster--bottom-right')).not.toMatch(/background/);
        // Centred on the map, or on the map left of the dock while a docked panel runs down to the
        // bottom-right corner (the status line takes the same centre).
        expect(ruleBody(mapShellCss, '\\.map-shell-cluster--bottom-right')).toMatch(/left:\s*var\(--map-shell-centre, 50%\)/);
        expect(ruleBody(utilitiesCss, '\\.map-feedback-stack')).toMatch(/left:\s*var\(--map-shell-centre, 50%\)/);
        const [wide] = mediaBlocksContaining(mapShellCss, '(min-width: 900px)', '--map-shell-centre:');
        expect(wide).toMatch(/body:has\(#road-info-panel\.visible\)/);
        expect(wide).toMatch(/--map-shell-centre:\s*calc\(\(100% - var\(--right-dock-width\) - 2 \* var\(--right-dock-gap\)\) \/ 2\)/);
        const [dock] = mediaBlocksContaining(panelsCss, '(min-width: 900px)', '--right-dock-bottom:');
        expect(dock).toMatch(/--right-dock-bottom:\s*var\(--right-dock-gap\)/);
        expect(ruleBody(panelsCss, '#parcel-info-panel')).toMatch(/bottom:\s*var\(--right-dock-bottom\)/);
        expect(ruleBody(panelsCss, '(?:^|\\n)#road-info-panel')).toMatch(/bottom:\s*var\(--right-dock-bottom\)/);
        expect(ruleBody(mapShellCss, '\\.map-shell-cluster--bottom-right \\.map-shell-button--labelled')).toMatch(/border-radius:\s*var\(--cb-radius-pill\)/);
    });

    it('stacks persistent banners in one card under the top row and keeps notices below it', () => {
        const primitives = read('css/primitives.css');
        expect(ruleBody(primitives, '\\.cb-banner-stack')).toMatch(/top:\s*var\(--map-shell-top-clearance\)/);
        expect(ruleBody(primitives, '\\.cb-banner \\+ \\.cb-banner')).toMatch(/border-top/);
        expect(ruleBody(utilitiesCss, '#ephemeral-message-container')).toMatch(/--cb-banner-stack-height/);
        // Every persistent banner mounts into the card; none keeps its own fixed position.
        expect(ruleBody(read('css/base.css'), '\\.cb-multitab-banner')).not.toMatch(/position/);
        expect(ruleBody(read('css/world.css'), '\\.explore-banner')).not.toMatch(/position/);
        expect(read('css/parcel-sources.css')).not.toMatch(/\.source-status-stack\s*\{/);
    });

    it('stacks map feedback in normal flow above the dock and hides the hint over the tile-load cover', () => {
        expect(indexHtml).toMatch(/id="map-feedback-stack"[^>]*>[\s\S]*id="floating-status"/);
        expect(ruleBody(utilitiesCss, '\.map-feedback-stack')).toMatch(/bottom:\s*var\(--map-shell-bottom-clearance\)/);
        expect(ruleBody(utilitiesCss, '\.map-feedback-stack')).toMatch(/display:\s*flex/);
        expect(ruleBody(utilitiesCss, '\.map-feedback-stack')).toMatch(/flex-direction:\s*column/);
        expect(ruleBody(utilitiesCss, '\.map-feedback-stack')).toMatch(/gap:\s*var\(--cb-space-2\)/);
        expect(photorealCss).toMatch(/\.map-feedback-stack \.three-view-hint\s*\{[^}]*max-width:\s*100%;/s);
        expect(photorealCss).not.toMatch(/\.three-view-hint\s*\{[^}]*bottom:/s);
        expect(photorealCss).toMatch(/#map-container:has\(\.photoreal-cover\) \.three-view-hint\s*\{\s*display:\s*none;/);
        expect(photorealCss).toMatch(/@keyframes three-view-hint-in\s*\{\s*from\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(6px\);\s*\}\s*to\s*\{\s*opacity:\s*1;\s*transform:\s*translateY\(0\);/);
        expect(threeMode).toMatch(/feedbackStack\.insertBefore\(el, status\)/);
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

    it('takes down the loading card before asking which city to open', () => {
        const prompt = cityPrompt.slice(cityPrompt.indexOf('async function promptCityMismatchForProposal'));
        expect(prompt.indexOf('hideProposalLoadOverlay()')).toBeGreaterThan(0);
        expect(prompt.indexOf('hideProposalLoadOverlay()')).toBeLessThan(prompt.indexOf('await askUser('));
    });

    it('makes the rooster entry a plain .btn row: its stylesheet lays it out and paints nothing', () => {
        expect(grainCss).not.toMatch(/\.btn\.grain-score-button\s*\{/);
        expect(grainCss).not.toMatch(/\.grain-score-button(?::[\w-]+(?:\([^)]*\))?)*\s*\{[^}]*\bbackground/);
    });

    it('gives the shell buttons the page font (a <button> does not inherit it)', () => {
        expect(ruleBody(mapShellCss, '\\n\\.map-shell-button')).toMatch(/font:\s*inherit;/);
        // The simulation's play button is a .btn, whose primitive gives it the page font.
        expect(indexHtml).toMatch(/id="game-play-pause-btn" class="btn\b[^"]*activity-simulation-play/);
        expect(ruleBody(primitivesCss, '\\n\\.btn')).toMatch(/font:\s*inherit;/);
    });

    it('lets a proposal title wrap on phones instead of cutting its distinguishing end', () => {
        const [block] = mediaBlocksContaining(proposalsCss, '(max-width: 767.98px)', '.proposal-card-head');
        expect(ruleBody(block, '\\.proposal-card-head')).toMatch(/flex-wrap:\s*wrap/);
        expect(ruleBody(block, '\\.proposal-list-item--compact \\.proposal-list-title')).toMatch(/white-space:\s*normal/);
    });
});

describe('the parcel-layout plot table holds its columns still', () => {
    const reparcelCss = read('css/on-map-reparcellization.css');

    it('takes column widths from the headers, not the figures', () => {
        expect(ruleBody(reparcelCss, '\\.reparcel-newplots-table')).toMatch(/table-layout:\s*fixed/);
        expect(ruleBody(reparcelCss, '\\.reparcel-col--figure')).toMatch(/width:/);
        const designer = read('js/parcel-layout.js');
        expect(designer.match(/<th class="reparcel-col--figure">/g)?.length).toBeGreaterThanOrEqual(2);
    });
});
