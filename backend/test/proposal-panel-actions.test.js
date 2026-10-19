// Protect the real proposal details renderer from hiding or dropping actions as its footer is reorganized.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { load } from 'cheerio';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const supportView = require('../../frontend/js/proposals/support-view.js');
const displayText = require('../../frontend/js/proposals/display-text.js');
const groundRebase = require('../../frontend/js/proposals/ground-rebase.js');
const ProposalKind = require('../../frontend/js/proposals/proposal-kind.js');
const displayState = require('../../frontend/js/proposals/display-state.js');
const panelPresentation = require('../../frontend/js/proposals/panel-presentation.js');
const referenceRelations = require('../../frontend/js/proposals/parcel-set-relations.js');
const siteDraft = require('../../frontend/js/proposals/site-draft.js');
// A mint record as the mint paths write it (proposals/display-state.js hasMintRecord).
const MINT_RECORD = Object.freeze({ chain: 'solana-devnet', contract: 'Prog1111', tokenId: 'Token1111111111111111111111111111111111' });
const source = readFileSync(new URL('../../frontend/js/proposals/details-panel.js', import.meta.url), 'utf8');
const renderStart = source.indexOf('function safeAgentText(');
const renderEnd = source.indexOf('\nlet proposalSupportWalletRefreshBound =');
if (renderStart < 0 || renderEnd <= renderStart) throw new Error('Could not isolate proposal details renderer');
const renderSource = `let proposalDetailsEscapeHandler = null;\n${source.slice(renderStart, renderEnd)}`;

function render(proposal, { applied = false, connected = false, road = false, summary = null, lifecycle = 'Active', approvalSetup = false, editable = null, actionError = '', forkOffer = false, sourceFeature = null, sourceFeatures = null, sourceReplaced = false, relatedProposals = null } = {}) {
    // Model the renderer's deferred HTML mount as well as its direct innerHTML path.
    const timers = [];
    const htmlContainer = () => ({ innerHTML: '', appendChild(node) { this.innerHTML += node.innerHTML; } });
    const content = { ...htmlContainer(), dataset: {}, scrollTop: 0, querySelectorAll: () => [], querySelector: () => null };
    const body = { scrollTop: 0, classList: { contains: () => false, add() {} } };
    const footer = { innerHTML: '', querySelector: () => null };
    const panelClasses = new Set();
    const panel = {
        classList: { contains: key => panelClasses.has(key), add: key => panelClasses.add(key), toggle: (key, yes) => yes ? panelClasses.add(key) : panelClasses.delete(key) },
        querySelector: selector => selector === '.panel-body' ? body : null
    };
    const fundingCard = { querySelector: () => ({ textContent: '' }) };
    const elements = new Map([
        ['proposal-details-content', content], ['proposal-details-footer', footer],
        ['proposal-details-panel', panel], ['proposal-details-title', { textContent: '', title: '' }],
        ['proposal-details-body', body]
    ]);
    const document = {
        body,
        getElementById: id => elements.get(id) || null,
        querySelector: selector => {
            if (selector.includes('data-proposal-support-actions')) {
                const $ = parse(footer.innerHTML);
                const mount = $('[data-proposal-support-actions]');
                if (!mount.length) return null;
                return { set innerHTML(value) { mount.html(value); footer.innerHTML = $('main').html(); } };
            }
            return selector.includes('proposal-pledge-summary') ? fundingCard : null;
        },
        querySelectorAll: () => [],
        addEventListener() {}, removeEventListener() {},
        createDocumentFragment: htmlContainer,
        createElement: () => ({ ...htmlContainer(), get childNodes() { return [{ innerHTML: this.innerHTML }]; }, get firstChild() { return null; } })
    };
    const window = {
        i18n: null,
        __proposalMapActionFailures: actionError ? { [String(proposal.proposalId)]: actionError } : {},
        __proposalGroundForkOffers: forkOffer ? { [String(proposal.proposalId)]: true } : {},
        ProposalGroundRebase: groundRebase,
        addEventListener() {}, removeEventListener() {},
        MapShell: { closeSheets() {} },
        ProposalDisplayText: displayText,
        __proposalDisplayState: displayState,
        ProposalPanelPresentation: panelPresentation,
        ProposalApprovalText: require('../../frontend/js/proposals/approval-text.js'),
        ProposalArea: require('../../frontend/js/proposals/area.js'),
        CadastralParcelRepository: {
            get: vi.fn(id => sourceFeatures ? sourceFeatures.find(feature => feature.properties.parcelId === id) : sourceFeature),
            peekMany: ids => (sourceFeatures || [sourceFeature].filter(Boolean)).filter(feature => ids.includes(feature.properties.parcelId))
        },
        __siteDraft: { siteAreaM2: site => siteDraft.siteAreaM2(site, { turf }) },
        ProposalSupportView: supportView,
        ProposalKind,
        ProposalPublishTerms: require('../../frontend/js/proposals/publish-terms.js'),
        solanaWalletManager: { getState: () => connected ? { status: 'connected', accounts: ['wallet'] } : { status: 'disconnected', accounts: [] } },
        SolanaPledgeBridge: { readSummary: vi.fn(() => Promise.resolve(summary || {})) },
        SolanaPledgeClient: { formatUsdc: value => String(value) },
        ProposalAgentProvenance: null,
        ParcelSetRelations: relatedProposals ? referenceRelations : null,
        OwnerOffer: null,
        ProposalLensCard: null,
        ProposalParcelHistoryCard: { mountAfter() {} },
        ProposalPossibilityTimeline: null,
        getSerialProposalId: () => road ? 'track-1' : null,
        SolanaMarketBridge: null,
        ProposalApprovalRuntime: approvalSetup ? { uses: () => true } : null,
        RoadActions: road ? { factsFor: () => ({ proposalKey: proposal.proposalId, applied: true }), runAction() {} } : null,
        RoadActionsModel: road ? { isActionAvailable: () => true } : null,
        __claims: { materializedParcelIdsOf: () => [] }
    };
    const globals = {
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
        getProposalDisplayDescription: () => '', getProposalNftInfo: item => item.nft ? { tokenId: 'Token1111111111111111111111111111111111', chain: 'solana-devnet' } : null,
        buildProposalNftExplorerUrl: () => null,
        isProposalMinted: item => !!item.nft, isProposalApplied: () => applied,
        ProposalMapAction: { presentation: isApplied => ({ label: isApplied ? 'Unapply' : 'Apply', iconClass: 'fa-check', className: 'btn-warning' }) },
        computeProposalCategoryFlags: () => ({ isRoadProposal: road, isBuildingProposal: false, isStructureProposal: false, isReparcellizationProposal: false, supportsMapToggle: true }),
        resolveProposalActionTypeKey: () => 'building', getLifecycleStatus: () => lifecycle,
        isNonBindingProposal: proposal => ProposalKind.isNonBinding(proposal),
        proposalKindBadgeHtml: () => '',   // list-ui.js; the kind badge is not this test's subject
        getProposalLifecycleKey: () => lifecycle.toLowerCase(), getProposalLifecycleClass: () => '', getProposalLifecycleLabel: () => lifecycle,
        buildProposalOwnerAcceptanceSummaryFast: () => ({ totalOwners: 0 }),
        getProposalLensEntries: () => [], getLensPatternDataUrl: () => null,
        getProposalKey: item => item.proposalId, resolveProposalIdKey: value => value,
        computeProposalArea: () => 0, getProposalParcelCount: () => 0,
        getParcelDisplayNumberFromProperties: (_props, id) => id, getProposalActionTypeLabel: () => '',
        isParcelReplacedByChildren: () => sourceReplaced, ensureParcelIdOnFeature: feature => feature,
        getParcelIdFromFeature: feature => feature.properties.parcelId,
        canEditProposalGeometry: () => !road, editProposalGeometry() {},
        isProposalOpenSaleOffer: item => !!item.saleOffer, simulateSaleOfferPurchase() {},
        CityConfigManager: { getDriveConfig: () => ({ url: 'https://example.test' }) },
        corridorIsTrack: () => road,
        toggleProposalDetailsPanelMinimized() {}, shareProposalFromDetails() {},
        applyProposalToMap() {}, removeProposalFromMap() {}, proposeExistingProposal() {},
        setupLazyList() {}, restoreProposalDetailsScroll() {},
        initializeExpiryCountdown() {}, initializeDecayCountdown() {},
        ensureProposalOverlayGroups: () => ({ buildingPreview: { clearLayers() {} } }),
        clearProposalInfoHoverOverlay() {}, clearProposalHoverLayers() {},
        renderProposalBuildingPreview() {}, installProposalDetailsEscapeHandler() {},
        bindProposalSupportWalletRefresh() {}, getProposalDetailsPanelLabels: () => ({}),
        ensureProposalMetadataLoaded: async () => null,
        setProposalDetailsPanelMinimized() {}, setupGameLogClickListeners() {},
        hideProposalDetailsPanel() {},
        buildOwnerAcceptanceSectionHtml: () => '',
        ...(editable === null ? {} : { getProposalEditCapability: () => ({ editable }), editProposalApproval() {} })
    };
    if (proposal.lifecycleStatus === undefined) proposal.lifecycleStatus = lifecycle;
    const context = vm.createContext(globals);
    vm.runInContext(`${renderSource}\nthis.renderProposal = showProposalInfo;`, context);
    context.renderProposal(proposal, null, null, { presentation: 'compact' });
    while (timers.length) timers.shift()();
    return { footer, content, window };
}

const parse = html => load(`<main>${html}</main>`);

describe('proposal details action footer', () => {
    it('shows authored payout terms without promising that acceptance releases money', () => {
        const base = { proposalId: 'payout-terms', cadastreParcelIds: [] };
        const badge = terms => parse(render({ ...base, ...terms }).content.innerHTML)('[data-proposal-payout-terms]');
        expect(badge({}).length).toBe(0);
        expect(badge({ offer: 0, isConditional: false }).length).toBe(0);
        expect(badge({ kind: 'owner-vote', offer: 100, isConditional: true }).length).toBe(0);
        expect(badge({ offer: 100, isConditional: true }).text()).toBe('Payout terms: all owners');
        expect(badge({ offer: 100, isConditional: true }).attr('title')).toContain('does not confirm funding or payment');
        expect(badge({ offer: 100, isConditional: false }).text()).toBe('Payout terms: partial');
        expect(badge({ offer: 100, isConditional: false }).attr('title')).toContain('Acceptance alone does not confirm payment');
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
        const proposal = { proposalId: 'target', cadastreParcelIds: ['source-1', 'source-2'] };
        const relatedProposals = Array.from({ length: 15 }, (_, i) => ({
            proposalId: `related-${i}`, title: `Reference match ${i}`, cadastreParcelIds: i < 13 ? ['source-1', 'source-2'] : ['source-2']
        }));
        const card = parse(render(proposal, { relatedProposals }).content.innerHTML)('.proposal-parcel-set-card');
        expect(card.find('h3').text()).toBe('Proposals sharing references');
        expect(card.find('p').text()).toBe('2 declared cadastral references. Of 15 loaded matches, 13 use the same references and 2 share some. Showing 12.');
        expect(card.find('[data-related-proposal-id]')).toHaveLength(12);
        expect(card.text()).not.toContain('Overlapping land');
    });

    it.each([false, true])('does not describe unloaded source geometry as removed or pooled (readjustment: %s)', readjustment => {
        const proposal = { proposalId: 'source-state', cadastreParcelIds: ['source-1'],
            ...(readjustment ? { reparcellization: { polygons: [] } } : {}) };
        const row = parse(render(proposal).content.innerHTML)('.proposal-parcel-row');
        expect(row.attr('data-reference-state')).toBe('unloaded');
        expect(row.attr('data-parcel-replaced')).toBeUndefined();
        expect(row.find('.parcel-status').text()).toBe('Source geometry not loaded');
        expect(row.hasClass('is-replaced')).toBe(false);
    });

    it('shows replacement only from current map evidence and retains the source geometry for focus', () => {
        const proposal = { proposalId: 'source-state', cadastreParcelIds: ['source-1'], reparcellization: { polygons: [] } };
        const geometry = { type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,0]]] };
        const sourceFeature = { type: 'Feature', properties: { parcelId: 'source-1' }, geometry };
        const available = parse(render(proposal, { sourceFeature }).content.innerHTML)('.proposal-parcel-row');
        expect(available.attr('data-reference-state')).toBe('available');
        expect(available.find('.parcel-status').text()).toBe('Pending');
        const replaced = parse(render(proposal, { sourceFeature, sourceReplaced: true }).content.innerHTML)('.proposal-parcel-row');
        expect(replaced.attr('data-parcel-replaced')).toBe('true');
        expect(replaced.hasClass('is-replaced')).toBe(true);
        expect(replaced.find('.parcel-status').text()).toBe('Replaced in map model');
        expect(JSON.parse(replaced.attr('data-parcel-geometry'))).toEqual(geometry);
    });

    it.each([
        { goal: 'ownership-transfer-from-me', funded: false },
        { goal: 'parcelBased', ownershipTransferProposal: { direction: 'from-me' }, funded: true },
        { goal: 'ownership-transfer-from-me', funded: true, decayEnabled: true, decayPercent: 10, decayDurationMs: 60000 }
    ])('shows seller funding availability without a synthetic remaining amount or payment action: %j', terms => {
        const proposal = { proposalId: 'seller-1', title: 'Seller offer', cadastreParcelIds: [], offer: 100, offerCurrency: 'EUR', ...terms };
        const $ = parse(render(proposal).content.innerHTML);
        expect($('.proposal-offer-funding-note').text()).toBe('Funding this offer is not available here.');
        expect($('.offer-amount').text()).toBe('€100');
        expect($('.proposal-no-deposit-warning').text().trim()).toBe('⚠️ No deposit specified');
        expect($('.proposal-offer-bar button').length).toBe(0);
        expect($.text()).not.toContain('Amount still needed');
    });

    it('does not apply the seller funding note to a general proposal offer', () => {
        const $ = parse(render({ proposalId: 'park-1', goal: 'park', cadastreParcelIds: [], offer: 100 }).content.innerHTML);
        expect($('.proposal-offer-funding-note').length).toBe(0);
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
        { proposalId: 'local-1', cadastreParcelIds: [] },
        { proposalId: 'minted-1', cadastreParcelIds: [], nft: MINT_RECORD }
    ])('offers Bet on outcome last, on its own row of the shared action footer, for every proposal', proposal => {
        const result = render(proposal);
        const footer = parse(result.footer.innerHTML);
        const button = footer('.proposal-bet-actions .btn-bet-proposal');
        expect(button.length).toBe(1);
        expect(footer('.proposal-primary-actions .btn-bet-proposal').length).toBe(0);
        expect(footer('button').last().hasClass('btn-bet-proposal')).toBe(true);
        expect(button.text()).toContain('Bet on outcome');
        expect(button.attr('disabled')).toBeUndefined();
        expect(result.footer.innerHTML).toContain(`openProposalOutcomeBet("${proposal.proposalId}")`);
        expect(parse(result.content.innerHTML)('.btn-bet-proposal').length).toBe(0);
        const approval = render(proposal, { approvalSetup: true });
        expect(parse(approval.footer.innerHTML)('.btn-bet-proposal').length).toBe(1);
    });

    it('leaves out donations, pledges and the market for a minted approval setup the contract never executes', () => {
        const proposal = { proposalId: 'approval-1', title: 'Readjustment', cadastreParcelIds: [], nft: MINT_RECORD };
        const plain = render(proposal, { connected: true });
        expect(parse(plain.footer.innerHTML)('[data-proposal-support-actions]').length).toBe(1);
        expect(parse(plain.content.innerHTML)('.proposal-pledge-summary, .proposal-market-summary').length).toBe(2);
        const setup = render(proposal, { connected: true, approvalSetup: true });
        const content = parse(setup.content.innerHTML);
        expect(parse(setup.footer.innerHTML)('[data-proposal-support-actions]').length).toBe(0);
        expect(content('.proposal-pledge-summary, .proposal-market-summary').length).toBe(0);
        expect(content('[data-proposal-section="funding"], [data-proposal-section="market"]').length).toBe(0);
        expect(content('.proposal-lens-card').length).toBe(1);
        expect(content('.approval-card-slot').length).toBe(1);
    });

    it('opens the editor on its Approval tab from Land & ownership, only for a proposal the editor can open', () => {
        const proposal = { proposalId: 'p-1', title: 'Readjustment', cadastreParcelIds: [] };
        const button = options => parse(render(proposal, options).content.innerHTML)('.btn-edit-approval');
        expect(button({ editable: true }).text()).toContain('Add ownership and approval');
        expect(render(proposal, { editable: true }).content.innerHTML).toContain('onclick="editProposalApproval("p-1")"');
        expect(button({ editable: true, approvalSetup: true }).text()).toContain('Edit ownership and approval');
        expect(button({ editable: false, approvalSetup: true }).length).toBe(0);
        expect(button({}).length).toBe(0);
    });

    it('renders primary and contextual actions, plus disconnected support in the footer once', () => {
        const proposal = { proposalId: 'proposal-1', title: 'Garden', cadastreParcelIds: [], nft: MINT_RECORD, saleOffer: true };
        const result = render(proposal, { connected: false });
        const $ = parse(result.footer.innerHTML);
        expect($('.proposal-action-default').length + $('[onclick^="removeProposalFromMap"]').length).toBe(1);
        expect($('[onclick^="shareProposalFromDetails"]').length).toBe(1);
        expect($('[onclick^="proposeExistingProposal"]').length).toBe(1);
        expect($('.btn-proposal-details').length).toBe(1);
        expect($('.proposal-buy-btn').length).toBe(1);
        expect($('.btn-connect-proposal-support').length).toBe(1);
        expect($('[data-proposal-support-actions]').length).toBe(1);
        expect(parse(result.content.innerHTML)('[data-proposal-support-actions]').length).toBe(0);
        expect($.text()).not.toContain('changed land');
    });

    it('renders contextual geometry and track actions, and refreshes support actions after summary hydration', async () => {
        const building = render({ proposalId: 'local-1', title: 'House', cadastreParcelIds: [] });
        expect(parse(building.footer.innerHTML)('.btn-edit-geometry').length).toBe(1);

        const road = render({ proposalId: 'track-1', title: 'Rail', cadastreParcelIds: [], roadProposal: { definition: {} } }, { applied: true, road: true });
        expect(parse(road.footer.innerHTML)('.btn-cross-section').length).toBe(1);
        expect(parse(road.footer.innerHTML)('.btn-drive-proposal').length, road.footer.innerHTML).toBe(1);

        const onchain = render({ proposalId: 'chain-1', title: 'Garden', cadastreParcelIds: [], nft: MINT_RECORD }, {
            connected: true, summary: { wallet: 'wallet', myPledge: { status: 0, amount: 25n } }
        });
        expect(parse(onchain.footer.innerHTML)('.btn-edit-geometry').length).toBe(1);
        await Promise.resolve();
        await Promise.resolve();
        const support = parse(onchain.footer.innerHTML);
        expect(support('.btn-donate-proposal').length).toBe(1);
        expect(support('.btn-pledge-proposal').length).toBe(1);
        expect(support('.proposal-support-actions').text()).toContain('Revoke my pledge');

        const executed = render({ proposalId: 'chain-executed', title: 'Built', cadastreParcelIds: [], nft: MINT_RECORD }, {
            connected: true, lifecycle: 'Executed',
            summary: { wallet: 'wallet', donations: { totalDonated: 25n, totalRefunded: 0n, released: false } }
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(parse(executed.footer.innerHTML)('.proposal-support-actions').text()).toContain('Release donations');

        const cancelled = render({ proposalId: 'chain-cancelled', title: 'Cancelled', cadastreParcelIds: [], nft: MINT_RECORD }, {
            connected: true, lifecycle: 'Cancelled',
            summary: { wallet: 'wallet', myDonations: [{ amount: 10n, refunded: false }], myPledge: { status: 0, amount: 5n } }
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(parse(cancelled.footer.innerHTML)('.proposal-support-actions').text()).toContain('Refund my donations');
        expect(parse(cancelled.footer.innerHTML)('.proposal-support-actions').text()).toContain('Clear my pledge');
    });

    // Proposal 781 on the local stack: Cancelled on the server, applied in this browser. The panel
    // showed Published + Applied and an Unapply button.
    it('shows a cancelled proposal applied in this browser as Cancelled, without Applied or a map action', () => {
        const cancelled = render({ proposalId: 'c2-uh980k1g32gls', serverProposalId: '781', title: 'Road 1008-1649', cadastreParcelIds: [] },
            { applied: true, lifecycle: 'Cancelled' });
        const badges = parse(cancelled.content.innerHTML)('.proposal-badges-row');
        expect(badges.find('.cb-badge--applied')).toHaveLength(0);
        expect(badges.text()).toContain('Cancelled');
        expect(badges.find('.cb-badge--minted')).toHaveLength(0);
        const footer = parse(cancelled.footer.innerHTML);
        expect(footer('[onclick^="removeProposalFromMap"]')).toHaveLength(0);
        expect(footer('[onclick^="applyProposalToMap"]')).toHaveLength(0);
        expect(footer.text()).not.toContain('Unapply');

        const active = render({ proposalId: 'c2-cyjp51xcmdh3', serverProposalId: '780', title: 'Block 1108-0124', cadastreParcelIds: [] },
            { applied: true, lifecycle: 'Active' });
        expect(parse(active.content.innerHTML)('.proposal-badges-row .cb-badge--applied')).toHaveLength(1);
        expect(parse(active.footer.innerHTML)('[onclick^="removeProposalFromMap"]')).toHaveLength(1);
    });

    it('badges a mint record Minted and a bare numeric id only by its serial', () => {
        const minted = render({ proposalId: 'chain-2', title: 'Garden', cadastreParcelIds: [], nft: MINT_RECORD });
        expect(parse(minted.content.innerHTML)('.proposal-badges-row .cb-badge--minted')).toHaveLength(1);
        const serial = render({ proposalId: '780', title: 'Block', cadastreParcelIds: [] });
        expect(parse(serial.content.innerHTML)('.proposal-badges-row .cb-badge--minted')).toHaveLength(0);
    });

    it('presents execution as the recorded lifecycle with a separate map-state badge', () => {
        const result = render({ proposalId: 'recorded-execution', lifecycleStatus: 'Executed', cadastreParcelIds: [] },
            { lifecycle: 'Executed', applied: true });
        const badges = parse(result.content.innerHTML)('.proposal-badges-row');
        expect(badges.find('.cb-badge--executed').text()).toBe('Execution recorded');
        expect(badges.find('.cb-badge--executed').attr('title')).toContain('does not verify payment');
        expect(badges.find('.cb-badge--applied')).toHaveLength(1);
    });
});
