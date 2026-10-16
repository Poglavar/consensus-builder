// Protect the real proposal details renderer from hiding or dropping actions as its footer is reorganized.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { load } from 'cheerio';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const supportView = require('../../frontend/js/proposals/support-view.js');
const source = readFileSync(new URL('../../frontend/js/proposals/details-panel.js', import.meta.url), 'utf8');
const renderStart = source.indexOf('function safeAgentText(');
const renderEnd = source.indexOf('\nlet proposalSupportWalletRefreshBound =');
if (renderStart < 0 || renderEnd <= renderStart) throw new Error('Could not isolate proposal details renderer');
const renderSource = `let proposalDetailsEscapeHandler = null;\n${source.slice(renderStart, renderEnd)}`;

function render(proposal, { applied = false, connected = false, road = false, summary = null, lifecycle = 'Active', approvalSetup = false, editable = null, actionError = '' } = {}) {
    const content = { dataset: {}, innerHTML: '', scrollTop: 0, querySelectorAll: () => [], querySelector: () => null };
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
        createDocumentFragment: () => ({ appendChild() {} }),
        createElement: () => ({ set innerHTML(value) { this._html = value; }, get firstChild() { return null; }, appendChild() {} })
    };
    const window = {
        i18n: null,
        __proposalMapActionFailures: actionError ? { [String(proposal.proposalId)]: actionError } : {},
        addEventListener() {}, removeEventListener() {},
        MapShell: { closeSheets() {} },
        ProposalDisplayText: { text: value => String(value || ''), parcelLabel: value => value },
        ProposalPanelPresentation: { resolve: () => 'compact' },
        ProposalSupportView: supportView,
        solanaWalletManager: { getState: () => connected ? { status: 'connected', accounts: ['wallet'] } : { status: 'disconnected', accounts: [] } },
        SolanaPledgeBridge: { readSummary: vi.fn(() => Promise.resolve(summary || {})) },
        SolanaPledgeClient: { formatUsdc: value => String(value) },
        ProposalAgentProvenance: null,
        ParcelSetRelations: null,
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
        performance: { now: () => 1 }, requestAnimationFrame: callback => callback(), setTimeout: () => 1, clearTimeout() {},
        proposalStorage: { getProposal: () => proposal, getAllProposals: () => [], _indexProposal() {}, save() {} },
        PersistentStorage: { getItem: () => null },
        ProposalManager: { applyProposal() {}, unapplyProposal() {}, _getProposalDescendants: () => [] },
        APPLY_DISABLED_TYPE_KEYS: new Set(),
        ensureArrayOfStrings: value => Array.isArray(value) ? value.map(String) : [],
        inlineJsArg: value => JSON.stringify(String(value ?? '')),
        getProposalI18nHelper: () => (_key, fallback) => fallback,
        getProposalDisplayTitle: item => item.title || 'Untitled', getProposalDisplayTypeLabel: () => '',
        getProposalDisplayDescription: () => '', getProposalNftInfo: item => item.nft ? { tokenId: 'Token1111111111111111111111111111111111', chain: 'solana-devnet' } : null,
        buildProposalNftExplorerUrl: () => null,
        isProposalMinted: item => !!item.nft, isProposalApplied: () => applied,
        ProposalMapAction: { presentation: isApplied => ({ label: isApplied ? 'Unapply' : 'Apply', iconClass: 'fa-check', className: 'btn-warning' }) },
        computeProposalCategoryFlags: () => ({ isRoadProposal: road, isBuildingProposal: false, isStructureProposal: false, isReparcellizationProposal: false, supportsMapToggle: true }),
        resolveProposalActionTypeKey: () => 'building', getLifecycleStatus: () => lifecycle,
        getProposalLifecycleKey: () => lifecycle.toLowerCase(), getProposalLifecycleClass: () => '', getProposalLifecycleLabel: () => lifecycle,
        buildProposalOwnerAcceptanceSummaryFast: () => ({ totalOwners: 0 }),
        getProposalLensEntries: () => [], getLensPatternDataUrl: () => null,
        getProposalKey: item => item.proposalId, resolveProposalIdKey: value => value,
        computeProposalArea: () => 0, getProposalParcelCount: () => 0,
        getParcelDisplayNumberFromProperties: (_props, id) => id, getProposalActionTypeLabel: () => '',
        isParcelReplacedByChildren: () => false, ensureParcelIdOnFeature: feature => feature,
        getParcelIdFromFeature: feature => feature.properties.parcelId,
        canEditProposalGeometry: () => !road, editProposalGeometry() {},
        isProposalOpenSaleOffer: item => !!item.saleOffer, claimSaleOffer() {},
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
    const context = vm.createContext(globals);
    vm.runInContext(`${renderSource}\nthis.renderProposal = showProposalInfo;`, context);
    context.renderProposal(proposal, null, null, { presentation: 'compact' });
    return { footer, content, window };
}

const parse = html => load(`<main>${html}</main>`);

describe('proposal details action footer', () => {
    it('keeps a failed map-application reason visible in the proposal panel', () => {
        const proposal = { proposalId: 'lake-1', title: 'Lake', cadastreParcelIds: [] };
        const result = render(proposal, { actionError: 'Geometry extends beyond this site.' });
        const panel = parse(result.footer.innerHTML);

        expect(panel('[data-proposal-map-action-error]').attr('role')).toBe('alert');
        expect(panel('[data-proposal-map-action-error]').attr('data-proposal-map-action-error')).toBe('lake-1');
        expect(panel('[data-proposal-map-action-error]').text()).toBe('Geometry extends beyond this site.');
    });

    it.each([
        { proposalId: 'local-1', cadastreParcelIds: [] },
        { proposalId: 'minted-1', cadastreParcelIds: [], nft: { chainId: 'solana-devnet' } }
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
        const proposal = { proposalId: 'approval-1', title: 'Readjustment', cadastreParcelIds: [], nft: { chainId: 'solana-devnet' } };
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
        const proposal = { proposalId: 'proposal-1', title: 'Garden', cadastreParcelIds: [], nft: { chainId: 'solana-devnet' }, saleOffer: true };
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

        const onchain = render({ proposalId: 'chain-1', title: 'Garden', cadastreParcelIds: [], nft: { chainId: 'solana-devnet' } }, {
            connected: true, summary: { wallet: 'wallet', myPledge: { status: 0, amount: 25n } }
        });
        expect(parse(onchain.footer.innerHTML)('.btn-edit-geometry').length).toBe(1);
        await Promise.resolve();
        await Promise.resolve();
        const support = parse(onchain.footer.innerHTML);
        expect(support('.btn-donate-proposal').length).toBe(1);
        expect(support('.btn-pledge-proposal').length).toBe(1);
        expect(support('.proposal-support-actions').text()).toContain('Revoke my pledge');

        const executed = render({ proposalId: 'chain-executed', title: 'Built', cadastreParcelIds: [], nft: { chainId: 'solana-devnet' } }, {
            connected: true, lifecycle: 'Executed',
            summary: { wallet: 'wallet', donations: { totalDonated: 25n, totalRefunded: 0n, released: false } }
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(parse(executed.footer.innerHTML)('.proposal-support-actions').text()).toContain('Release donations');

        const cancelled = render({ proposalId: 'chain-cancelled', title: 'Cancelled', cadastreParcelIds: [], nft: { chainId: 'solana-devnet' } }, {
            connected: true, lifecycle: 'Cancelled',
            summary: { wallet: 'wallet', myDonations: [{ amount: 10n, refunded: false }], myPledge: { status: 0, amount: 5n } }
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(parse(cancelled.footer.innerHTML)('.proposal-support-actions').text()).toContain('Refund my donations');
        expect(parse(cancelled.footer.innerHTML)('.proposal-support-actions').text()).toContain('Clear my pledge');
    });
});
