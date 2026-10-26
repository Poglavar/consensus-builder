// Protect the real proposal details renderer from hiding or dropping actions as its footer is reorganized.
// Since M2 (plan-design-agreement.md) a design's details carry no lifecycle badges, consent card,
// terms, funding, support, market or bet: those belong to the agreement that includes the design.
// Since M3 only an agreement is minted: a design reads Draft or Published, never Minted.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { load } from 'cheerio';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const displayText = require('../../frontend/js/proposals/display-text.js');
const groundRebase = require('../../frontend/js/proposals/ground-rebase.js');
const designRecord = require('../../frontend/js/design-record.js');
const designSync = require('../../frontend/js/proposals/design-sync.js');
const displayState = require('../../frontend/js/proposals/display-state.js');
const panelPresentation = require('../../frontend/js/proposals/panel-presentation.js');
const referenceRelations = require('../../frontend/js/proposals/parcel-set-relations.js');
const siteDraft = require('../../frontend/js/proposals/site-draft.js');
const proposalOrigin = require('../../frontend/js/proposals/origin.js');
// The index the renderer's DesignSync reads publication against (design-sync.js publishedCid).
const API_BASE = 'https://api.example.test';
// A local design marked published at API_BASE under the CID it hashes to.
const published = record => ({ ...record, published: { cid: designRecord.cidOf(record), publishedAt: '2026-10-21T10:00:00.000Z', apiBase: API_BASE } });
const source = readFileSync(new URL('../../frontend/js/proposals/details-panel.js', import.meta.url), 'utf8');
const renderStart = source.indexOf('function safeAgentText(');
const renderEnd = source.indexOf('\nfunction rerenderProposalDetailsForLanguage(');
if (renderStart < 0 || renderEnd <= renderStart) throw new Error('Could not isolate proposal details renderer');
const renderSource = `let proposalDetailsEscapeHandler = null;\n${source.slice(renderStart, renderEnd)}`;

function render(proposal, { applied = false, road = false, lifecycle = 'Active', actionError = '', forkOffer = false, sourceFeature = null, sourceFeatures = null, sourceReplaced = false, relatedProposals = null } = {}) {
    // Model the renderer's deferred HTML mount as well as its direct innerHTML path.
    const timers = [];
    const htmlContainer = () => ({ innerHTML: '', appendChild(node) { this.innerHTML += node.innerHTML; } });
    const content = { ...htmlContainer(), dataset: {}, scrollTop: 0, querySelectorAll: () => [], querySelector: () => null };
    const body = { scrollTop: 0, classList: { contains: () => false, add() {} } };
    const footer = { innerHTML: '', querySelector: () => null };
    const panelClasses = new Set();
    const panel = {
        closest: () => panelClasses.has('is-hosted') ? panel : null,
        classList: { contains: key => panelClasses.has(key), add: key => panelClasses.add(key), toggle: (key, yes) => yes ? panelClasses.add(key) : panelClasses.delete(key) },
        querySelector: selector => selector === '.panel-body' ? body : null
    };
    const elements = new Map([
        ['proposal-details-content', content], ['proposal-details-footer', footer],
        ['proposal-details-panel', panel], ['proposal-details-title', { textContent: '', title: '' }],
        ['proposal-details-body', body]
    ]);
    const document = {
        body,
        getElementById: id => elements.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {}, removeEventListener() {},
        createDocumentFragment: htmlContainer,
        createElement: () => ({ ...htmlContainer(), get childNodes() { return [{ innerHTML: this.innerHTML }]; }, get firstChild() { return null; } })
    };
    const window = {
        ClickStackRelations: require('../../frontend/js/click-stack/click-stack-relations.js'),
        ClickStack: { showDesign: vi.fn() },
        CityMoney: require('../../frontend/js/city-money.js'),
        ProposalDesignGoals: require('../../frontend/js/proposals/design-goals.js'),
        i18n: null,
        __proposalMapActionFailures: actionError ? { [String(proposal.proposalId)]: actionError } : {},
        __proposalGroundForkOffers: forkOffer ? { [String(proposal.proposalId)]: true } : {},
        ProposalGroundRebase: groundRebase,
        addEventListener() {}, removeEventListener() {},
        MapShell: { closeSheets() {} },
        ProposalDisplayText: displayText,
        __proposalDisplayState: displayState,
        ProposalPanelPresentation: panelPresentation,
        ProposalArea: require('../../frontend/js/proposals/area.js'),
        CadastralParcelRepository: {
            get: vi.fn(id => sourceFeatures ? sourceFeatures.find(feature => feature.properties.parcelId === id) : sourceFeature),
            peekMany: ids => (sourceFeatures || [sourceFeature].filter(Boolean)).filter(feature => ids.includes(feature.properties.parcelId))
        },
        __siteDraft: { siteAreaM2: site => siteDraft.siteAreaM2(site, { turf }) },
        ProposalOrigin: proposalOrigin,
        DesignSync: { publishedCid: record => designSync.publishedCid(record, API_BASE) },
        ProposalPublishTerms: require('../../frontend/js/proposals/publish-terms.js'),
        ProposalAgentProvenance: null,
        ParcelSetRelations: relatedProposals ? referenceRelations : null,
        RoadActions: road ? { factsFor: () => ({ proposalKey: proposal.proposalId, applied: true }), runAction() {} } : null,
        RoadActionsModel: road ? { isActionAvailable: () => true } : null,
        __claims: { materializedParcelIdsOf: () => [] }
    };
    const globals = {
        CbFormat: require('../../frontend/js/format.js'),
        window, document, console, Date, Math, Number, String, Array, Object, Set, Map, Promise, JSON,
        escapeHtml: require('../../frontend/js/shared-utils.js').escapeHtml,
        performance: { now: () => 1 }, requestAnimationFrame: callback => callback(),
        setTimeout: callback => timers.push(callback), clearTimeout() {},
        proposalStorage: { getProposal: () => proposal, getAllProposals: () => relatedProposals || [], _indexProposal() {}, save() {} },
        PersistentStorage: { getItem: () => null },
        ProposalManager: { applyProposal() {}, unapplyProposal() {}, _getProposalDescendants: () => [] },
        APPLY_DISABLED_TYPE_KEYS: new Set(),
        ensureArrayOfStrings: value => Array.isArray(value) ? value.map(String) : [],
        inlineJsArg: value => JSON.stringify(String(value ?? '')),
        getProposalI18nHelper: () => (_key, fallback, params = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (match, key) => params[key] ?? match),
        getProposalDisplayTitle: item => item.title || 'Untitled', getProposalDisplayTypeLabel: () => '',
        getProposalDisplayDescription: () => '', isProposalApplied: () => applied,
        ProposalMapAction: { presentation: isApplied => ({ label: isApplied ? 'Unapply' : 'Apply', iconClass: 'fa-check', className: 'btn-warning' }) },
        computeProposalCategoryFlags: () => ({ isRoadProposal: road, isBuildingProposal: false, isStructureProposal: false, isParcelLayoutProposal: false, supportsMapToggle: true }),
        resolveProposalActionTypeKey: () => 'building', getLifecycleStatus: () => lifecycle,
        getProposalLifecycleKey: () => lifecycle.toLowerCase(), getProposalLifecycleClass: () => '', getProposalLifecycleLabel: () => lifecycle,
        getProposalKey: item => item.proposalId, resolveProposalIdKey: value => value,
        computeProposalArea: () => 0, getProposalParcelCount: () => 0,
        getParcelDisplayNumberFromProperties: (_props, id) => id, getProposalActionTypeLabel: () => '',
        isParcelReplacedByChildren: () => sourceReplaced, ensureParcelIdOnFeature: feature => feature,
        getParcelIdFromFeature: feature => feature.properties.parcelId,
        canEditProposalGeometry: () => !road, editProposalGeometry() {},
        CityConfigManager: { getDriveConfig: () => ({ url: 'https://example.test' }) },
        corridorIsTrack: () => road,
        toggleProposalDetailsPanelMinimized() {}, shareProposalFromDetails() {},
        applyProposalToMap() {}, removeProposalFromMap() {}, startDesignDuplication() {},
        setupLazyList() {}, restoreProposalDetailsScroll() {},
        ensureProposalOverlayGroups: () => ({ buildingPreview: { clearLayers() {} } }),
        clearProposalInfoHoverOverlay() {}, clearProposalHoverLayers() {},
        renderProposalBuildingPreview() {}, installProposalDetailsEscapeHandler() {},
        getProposalDetailsPanelLabels: () => ({}),
        setProposalDetailsPanelMinimized() {}, setupGameLogClickListeners() {},
        hideProposalDetailsPanel() {}
    };
    if (proposal.lifecycleStatus === undefined) proposal.lifecycleStatus = lifecycle;
    const context = vm.createContext(globals);
    vm.runInContext(`${renderSource}\nthis.renderProposal = showProposalInfo;`, context);
    context.renderProposal(proposal, null, null, { hosted: true, presentation: 'compact' });
    panelClasses.add('is-hosted');
    while (timers.length) timers.shift()();
    return {
        footer, content, window, panel, title: elements.get('proposal-details-title'),
        rerender(nextProposal = proposal) {
            context.renderProposal(nextProposal, null, true);
            while (timers.length) timers.shift()();
        }
    };
}

const parse = html => load(`<main>${html}</main>`);

describe('proposal details action footer', () => {
    it('keeps an open action panel when the same proposal refreshes', () => {
        const proposal = { proposalId: 'refresh-actions', title: 'Original terms', cadastreParcelIds: [] };
        const result = render(proposal);
        const inspectProposal = vi.fn();
        result.window.PlanningViews = { isReady: () => true, inspectProposal };
        proposal.title = 'Updated terms';
        result.rerender();
        expect(inspectProposal).not.toHaveBeenCalled();
        expect(result.panel.classList.contains('visible')).toBe(true);
        expect(result.title.textContent).toBe('Updated terms');
    });

    it.each(['closed', 'different'])('uses the click panel for a %s action context', context => {
        const proposal = { proposalId: 'selected-actions', cadastreParcelIds: [] };
        const result = render(proposal);
        const inspectProposal = vi.fn();
        result.window.PlanningViews = { isReady: () => true, inspectProposal };
        if (context === 'closed') result.panel.classList.toggle('visible', false);
        const nextProposal = context === 'different' ? { ...proposal, proposalId: 'another-proposal' } : proposal;
        result.rerender(nextProposal);
        expect(inspectProposal).not.toHaveBeenCalled();
        expect(result.window.ClickStack.showDesign).toHaveBeenCalledExactlyOnceWith(nextProposal.proposalId);
    });

    it('shows unknown source areas as an em dash and gives partial sums their actual coverage', () => {
        const proposal = { proposalId: 'areas', cadastreParcelIds: ['source-1', 'source-2'] };
        let content = parse(render(proposal).content.innerHTML);
        expect(content('[data-proposal-area-basis="source-parcels"] .metric-value').text()).toBe('—');
        expect(content('.proposal-area-coverage').text()).toBe('Areas available for 0 of 2 declared references.');
        content = parse(render(proposal, { sourceFeature: { type: 'Feature', geometry: null,
            properties: { parcelId: 'source-1', calculated_area: 100 } } }).content.innerHTML);
        expect(content('[data-proposal-area-basis="source-parcels"]').attr('data-area-complete')).toBe('false');
        expect(content('[data-proposal-area-basis="source-parcels"] .metric-label').text()).toBe('Available source parcel area:');
        expect(content('[data-proposal-area-basis="source-parcels"] .metric-value').text()).toBe('100 m²');
        expect(content('.proposal-area-coverage').text()).toBe('Areas available for 1 of 2 declared references.');
    });

    it('sums every retained source area even when only twenty parcel rows are rendered', () => {
        const sourceFeatures = Array.from({ length: 25 }, (_, i) => ({ type: 'Feature', geometry: null,
            properties: { parcelId: `source-${i}`, calculatedArea: 10 } }));
        const proposal = { proposalId: 'areas', cadastreParcelIds: sourceFeatures.map(feature => feature.properties.parcelId) };
        const result = render(proposal, { sourceFeatures });
        const content = parse(result.content.innerHTML);
        expect(result.window.CadastralParcelRepository.get).toHaveBeenCalledTimes(20);
        expect(content('.proposal-parcel-row')).toHaveLength(20);
        expect(content('[data-proposal-area-basis="source-parcels"]').attr('data-area-complete')).toBe('true');
        expect(content('[data-proposal-area-basis="source-parcels"] .metric-value').text()).toBe('250 m²');
        expect(content('.proposal-area-coverage').text()).toBe('Areas available for 25 of 25 declared references.');
    });

    it('measures the site separately even when all source parcel areas are known', () => {
        const site = { type: 'Polygon', coordinates: [[[0,0],[0.001,0],[0.001,0.001],[0,0.001],[0,0]]] };
        const proposal = { proposalId: 'areas', cadastreParcelIds: ['source-1'], site };
        const content = parse(render(proposal, { sourceFeature: { type: 'Feature', geometry: null,
            properties: { parcelId: 'source-1', calculated_area: 100 } } }).content.innerHTML);
        const siteArea = Number(content('[data-proposal-area-basis="site"] .metric-value').text().replace(/[^\d]/g, ''));
        expect(siteArea).toBeGreaterThan(12000);
        expect(siteArea).toBeLessThan(12500);
        expect(content('[data-proposal-area-basis="source-parcels"] .metric-value').text()).toBe('100 m²');
    });

    it('counts all loaded reference matches before limiting the visible list', () => {
        const parcelSet = { parcelSource: { sourceId: 'hr-cadastre', snapshotId: null } };
        const proposal = { proposalId: 'target', cadastreParcelIds: ['source-1', 'source-2'], parcelSet };
        const relatedProposals = Array.from({ length: 15 }, (_, i) => ({
            proposalId: `related-${i}`, title: `Reference match ${i}`, parcelSet,
            cadastreParcelIds: i < 13 ? ['source-1', 'source-2'] : ['source-2']
        }));
        const card = parse(render(proposal, { relatedProposals }).content.innerHTML)('.proposal-parcel-set-card');
        expect(card.find('h3').text()).toBe('Proposals sharing references');
        expect(card.find('p').text()).toBe('2 declared cadastral references. Of 15 loaded matches, 13 use the same references and 2 share some. Showing 12.');
        expect(card.find('[data-related-proposal-id]')).toHaveLength(12);
        expect(card.text()).not.toContain('Overlapping land');
    });

    it.each([false, true])('does not describe unloaded source geometry as removed or pooled (parcel layout: %s)', layout => {
        const proposal = { proposalId: 'source-state', cadastreParcelIds: ['source-1'],
            ...(layout ? { goal: 'parcel-layout', parcelLayout: { plots: [] } } : {}) };
        const row = parse(render(proposal).content.innerHTML)('.proposal-parcel-row');
        expect(row.attr('data-reference-state')).toBe('unloaded');
        expect(row.attr('data-parcel-replaced')).toBeUndefined();
        expect(row.find('.parcel-status').text()).toBe('Source geometry not loaded');
        expect(row.hasClass('is-replaced')).toBe(false);
    });

    it('shows replacement only from current map evidence and retains the source geometry for focus', () => {
        const proposal = { proposalId: 'source-state', cadastreParcelIds: ['source-1'], goal: 'parcel-layout', parcelLayout: { plots: [] } };
        const geometry = { type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,0]]] };
        const sourceFeature = { type: 'Feature', properties: { parcelId: 'source-1' }, geometry };
        const available = parse(render(proposal, { sourceFeature }).content.innerHTML)('.proposal-parcel-row');
        expect(available.attr('data-reference-state')).toBe('available');
        // A design has no owner acceptance: an available reference carries no Accepted/Pending status.
        expect(available.find('.parcel-status').length).toBe(0);
        expect(available.hasClass('is-accepted')).toBe(false);
        const replaced = parse(render(proposal, { sourceFeature, sourceReplaced: true }).content.innerHTML)('.proposal-parcel-row');
        expect(replaced.attr('data-parcel-replaced')).toBe('true');
        expect(replaced.hasClass('is-replaced')).toBe(true);
        expect(replaced.find('.parcel-status').text()).toBe('Replaced in map model');
        expect(JSON.parse(replaced.attr('data-parcel-geometry'))).toEqual(geometry);
    });

    it('keeps a failed map-application reason visible in the proposal panel', () => {
        const proposal = { proposalId: 'lake-1', title: 'Lake', cadastreParcelIds: [] };
        const result = render(proposal, { actionError: 'Geometry extends beyond this site.' });
        const panel = parse(result.footer.innerHTML);

        expect(panel('[data-proposal-map-action-error]').attr('role')).toBe('alert');
        expect(panel('[data-proposal-map-action-error]').attr('data-proposal-map-action-error')).toBe('lake-1');
        expect(panel('[data-proposal-map-action-error]').text()).toBe('Geometry extends beyond this site.');
        expect(panel('[data-ground-rebase]')).toHaveLength(0);
    });

    it('offers a new proposal with the same geometry under a ground-change error', () => {
        const proposal = { proposalId: '879', title: 'Block', cadastreParcelIds: ['HR-1-1'] };
        const result = render(proposal, { actionError: 'The proposal geometry extends beyond its selected cadastral parcels.', forkOffer: true });
        const panel = parse(result.footer.innerHTML);
        const button = panel('[data-proposal-map-action-error] [data-ground-rebase]');
        expect(button.attr('data-ground-rebase')).toBe('879');
        expect(button.text().trim()).toBe('New proposal with same geometry');
    });

    it.each([
        { proposalId: 'local-1', goal: 'park', cadastreParcelIds: [] },
        published({ proposalId: 'published-1', goal: 'park', title: 'Park', cadastreParcelIds: [] })
    ])('offers no bet, support or approval action on a design: those are its agreement\'s (%j)', proposal => {
        const result = render(proposal, { applied: true });
        const footer = parse(result.footer.innerHTML);
        const content = parse(result.content.innerHTML);
        expect(footer('.btn-bet-proposal, [data-proposal-support-actions], .btn-connect-proposal-support, .proposal-buy-btn').length).toBe(0);
        expect(content('.btn-bet-proposal, .btn-edit-approval, .proposal-lens-card, .approval-card-slot').length).toBe(0);
        expect(content('.proposal-pledge-summary, .proposal-market-summary, [data-proposal-payout-terms], .proposal-expiry-countdown').length).toBe(0);
        expect(content('#proposal-parcel-acceptance-section, #proposal-owner-acceptance-section').length).toBe(0);
        // The Share and Duplicate actions stay.
        expect(footer('.btn-share-proposal').length).toBe(1);
        expect(footer('.btn-duplicate-design').length).toBe(1);
    });

    it('keeps a parcel layout local: Share disabled with its reason, no Duplicate, Bet or approval action', () => {
        const proposal = { proposalId: 'layout-1', goal: 'parcel-layout', title: 'Layout', cadastreParcelIds: ['source-1'], parcelLayout: { plots: [] } };
        const result = render(proposal, { applied: true });
        const footer = parse(result.footer.innerHTML);
        const share = footer('.btn-share-proposal');
        expect(share.length).toBe(1);
        expect(share.attr('disabled')).toBeDefined();
        expect(share.attr('onclick')).toBeUndefined();
        expect(footer('.proposal-publish-later').text()).toBe('A parcel layout is published with its agreement. Propose an agreement that includes it.');
        expect(footer('.btn-duplicate-design').length).toBe(0);
        expect(footer('.btn-bet-proposal').length).toBe(0);
        expect(parse(result.content.innerHTML)('.btn-edit-approval').length).toBe(0);

        const park = parse(render({ proposalId: 'park-2', goal: 'park', cadastreParcelIds: [] }, { applied: true }).footer.innerHTML);
        expect(park('.btn-share-proposal').attr('disabled')).toBeUndefined();
        expect(park('.proposal-publish-later').length).toBe(0);
    });

    it('offers Add to agreement over an applied design: before the disabled Share for a parcel layout, after Share otherwise', () => {
        // The primary row's buttons in order, by the action each one is.
        const primaryRow = result => {
            const $ = parse(result.footer.innerHTML);
            return $('.proposal-primary-actions button').toArray().map(button => $(button));
        };
        const position = (row, className) => row.findIndex(button => button.hasClass(className));

        const layout = { proposalId: 'layout-2', goal: 'parcel-layout', title: 'Layout', cadastreParcelIds: ['source-1'], parcelLayout: { plots: [] } };
        const appliedLayout = render(layout, { applied: true });
        const layoutRow = primaryRow(appliedLayout);
        const layoutAdd = layoutRow[position(layoutRow, 'btn-create-agreement')];
        expect(layoutAdd.hasClass('btn-primary')).toBe(true);
        expect(layoutAdd.text()).toContain('Add to agreement');
        expect(position(layoutRow, 'btn-create-agreement')).toBeLessThan(position(layoutRow, 'btn-share-proposal'));
        expect(layoutRow[position(layoutRow, 'btn-share-proposal')].attr('disabled')).toBeDefined();
        expect(appliedLayout.footer.innerHTML).toContain('window.AgreementDialog.addDesign("layout-2")');

        const park = { proposalId: 'park-3', goal: 'park', title: 'Park', cadastreParcelIds: [] };
        const appliedPark = render(park, { applied: true });
        const parkRow = primaryRow(appliedPark);
        const parkAdd = parkRow[position(parkRow, 'btn-create-agreement')];
        expect(parkAdd.hasClass('btn-primary')).toBe(false);
        expect(position(parkRow, 'btn-create-agreement')).toBe(position(parkRow, 'btn-share-proposal') + 1);
        expect(parkRow[position(parkRow, 'btn-share-proposal')].hasClass('btn-primary')).toBe(true);
        expect(appliedPark.footer.innerHTML).toContain('window.AgreementDialog.addDesign("park-3")');

        // An agreement bundles designs applied to the map; one that is not offers none.
        for (const proposal of [layout, park]) {
            expect(parse(render(proposal).footer.innerHTML)('.btn-create-agreement').length).toBe(0);
        }
    });

    it('shows the type and state pills in the Overview row, with type first', () => {
        const content = parse(render({ proposalId: 'named-park', goal: 'park', title: 'Park', cadastreParcelIds: [] }).content.innerHTML);
        const badges = content('.proposal-badges-row > .cb-badge');
        expect(badges).toHaveLength(2);
        expect(badges.eq(0).attr('data-design-goal')).toBe('park');
        expect(badges.eq(0).text()).toContain('Park');
        expect(badges.eq(1).hasClass('proposal-ladder-badge')).toBe(true);
        expect(badges.eq(1).text()).toContain('Draft');
        expect(badges.eq(1).find('[aria-hidden="true"]')).toHaveLength(1);
        const appliedBadges = parse(render({ proposalId: 'applied-park', goal: 'park', title: 'Park', cadastreParcelIds: [] }, { applied: true }).content.innerHTML)
            ('.proposal-badges-row > .cb-badge');
        expect(appliedBadges).toHaveLength(3);
        expect(appliedBadges.eq(0).attr('data-design-goal')).toBe('park');
        expect(appliedBadges.eq(1).hasClass('cb-badge--applied')).toBe(true);
        expect(appliedBadges.eq(2).hasClass('proposal-ladder-badge')).toBe(true);
    });

    it('renders the primary and contextual actions once, Duplicate named for the design', () => {
        const proposal = { proposalId: 'proposal-1', goal: 'park', title: 'Garden', cadastreParcelIds: [] };
        const result = render(proposal);
        const $ = parse(result.footer.innerHTML);
        expect($('.proposal-action-default').length + $('[onclick^="removeProposalFromMap"]').length).toBe(1);
        expect($('[onclick*="shareProposalFromDetails"]').length).toBe(1);
        expect($('.btn-share-proposal').attr('title')).toBe('Share this design or its plan');
        expect($('[onclick^="startDesignDuplication"]').length).toBe(1);
        expect($('.btn-duplicate-design').text().trim()).toBe('Duplicate');
        expect($('.btn-duplicate-design').attr('title')).toBe('Move a copy with the pointer and click to place a new design.');
        expect($('.btn-proposal-details').length).toBe(1);
        expect($.text()).not.toContain('changed land');
    });

    it('renders contextual geometry and track actions; Drive only for a track design published at this index', () => {
        const building = render({ proposalId: 'local-1', title: 'House', cadastreParcelIds: [] });
        expect(parse(building.footer.innerHTML)('.btn-edit-geometry').length).toBe(1);

        const track = { proposalId: 'track-1', goal: 'road-track', title: 'Rail', cadastreParcelIds: [], roadProposal: { definition: { points: [[[15.96, 45.8], [15.961, 45.8]]] } } };
        const draft = render(track, { applied: true, road: true });
        expect(parse(draft.footer.innerHTML)('.btn-cross-section').length).toBe(1);
        // The sim reads a track by its CID, so a draft cannot be driven.
        expect(parse(draft.footer.innerHTML)('.btn-drive-proposal').length).toBe(0);
        const shared = render(published(track), { applied: true, road: true });
        expect(parse(shared.footer.innerHTML)('.btn-drive-proposal').length, shared.footer.innerHTML).toBe(1);
        // A mark for another index, or a design edited after publishing, is not published here.
        const elsewhere = { ...published(track), published: { ...published(track).published, apiBase: 'https://other.example.test' } };
        expect(parse(render(elsewhere, { applied: true, road: true }).footer.innerHTML)('.btn-drive-proposal').length).toBe(0);
        const edited = { ...published(track), title: 'Rail, edited' };
        expect(parse(render(edited, { applied: true, road: true }).footer.innerHTML)('.btn-drive-proposal').length).toBe(0);

        // A published design keeps Edit geometry (the edit forks it) and takes no donation or pledge.
        const garden = render(published({ proposalId: 'garden-1', goal: 'park', title: 'Garden', cadastreParcelIds: [] }));
        expect(parse(garden.footer.innerHTML)('.btn-edit-geometry').length).toBe(1);
        expect(parse(garden.footer.innerHTML)('.btn-donate-proposal, .btn-pledge-proposal, .proposal-support-actions').length).toBe(0);
    });

    // Proposal 781 on the local stack: Cancelled on the server, applied in this browser. The panel
    // showed Published + Applied and an Unapply button. A design shows no lifecycle badge since M2,
    // but a withdrawn record still cannot stand on the map (proposals/display-state.js).
    it('shows a cancelled record applied in this browser without Applied or a map action', () => {
        const cancelled = render({ proposalId: 'road-781', title: 'Road 1008-1649', cadastreParcelIds: [] },
            { applied: true, lifecycle: 'Cancelled' });
        const badges = parse(cancelled.content.innerHTML)('.proposal-badges-row');
        expect(badges.find('.cb-badge--applied')).toHaveLength(0);
        expect(badges.text()).not.toContain('Cancelled');
        const footer = parse(cancelled.footer.innerHTML);
        expect(footer('[onclick^="removeProposalFromMap"]')).toHaveLength(0);
        expect(footer('[onclick^="applyProposalToMap"]')).toHaveLength(0);
        expect(footer.text()).not.toContain('Unapply');

        const active = render({ proposalId: 'block-780', title: 'Block 1108-0124', cadastreParcelIds: [] },
            { applied: true, lifecycle: 'Active' });
        expect(parse(active.content.innerHTML)('.proposal-badges-row .cb-badge--applied')).toHaveLength(1);
        expect(parse(active.footer.innerHTML)('[onclick^="removeProposalFromMap"]')).toHaveLength(1);
    });

    it('badges a design published here Published, and anything else Draft', () => {
        const badge = proposal => parse(render(proposal).content.innerHTML)('.proposal-badges-row .proposal-ladder-badge');
        const design = { proposalId: 'park-780', goal: 'park', title: 'Block', cadastreParcelIds: [], site: { type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0]]] } };
        expect(badge(published(design)).hasClass('cb-badge--published')).toBe(true);
        // A bare numeric id says nothing about publication.
        expect(badge({ proposalId: '780', title: 'Block', cadastreParcelIds: [] }).hasClass('cb-badge--draft')).toBe(true);
        expect(badge(design).hasClass('cb-badge--draft')).toBe(true);
    });

    it('names the CID a published design is published as in its record section', () => {
        const design = published({ proposalId: 'park-1', goal: 'park', title: 'Pocket park', cadastreParcelIds: [] });
        const row = parse(render(design).content.innerHTML)('[data-proposal-published-cid]');
        expect(row.attr('data-proposal-published-cid')).toBe(design.published.cid);
        expect(row.find('.proposal-published-cid').attr('title')).toBe(design.published.cid);
        expect(row.find('.proposal-published-cid').text()).toBe(`${design.published.cid.slice(0, 12)}…${design.published.cid.slice(-6)}`);
        expect(parse(render({ proposalId: 'park-2', goal: 'park', title: 'Local', cadastreParcelIds: [] }).content.innerHTML)('[data-proposal-published-cid]').length).toBe(0);
    });
});
