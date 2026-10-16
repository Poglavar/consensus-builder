const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function browser(extra = {}) {
    const c = vm.createContext({ console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
        setTimeout, clearTimeout, AbortController, URLSearchParams, Date, addEventListener() {},
        PersistentStorage: { ensureReady() {} }, ...extra });
    c.window = c;
    return c;
}
function load(c, file) { vm.runInContext(read('frontend/js/' + file), c, { filename: file }); }
const polygon = { type: 'MultiPolygon', coordinates: [[[[15, 45], [15.0002, 45], [15.0002, 45.0002], [15, 45.0002], [15, 45]]]] };
function ownershipContext(extra = {}) {
    const c = browser({ __planOrder: {}, __consentSha256: { sha256Hex: s => crypto.createHash('sha256').update(s).digest('hex') }, ...extra });
    load(c, 'proposals/ownership-flow.js'); load(c, 'proposals/approval.js');
    return c;
}
function source() {
    return { proposalId: 'fictional-original', title: 'Block fixture', goal: 'buildings', cadastreParcelIds: ['HR-339164-2536'], site: polygon,
        buildingProposal: { parameters: { typology: 'block' }, buildings: [] }, offer: 122000, offerCurrency: 'USDT',
        depositEnabled: true, depositPercent: 12, decayEnabled: true, decayPercent: 3, decayDurationMs: 86400000,
        isConditional: true, lens: ['fixture-lens'], approvalConfig: { schema: 'proposal-approval/v1', policy: { type: 'unanimous' }, rights: null } };
}

for (const connected of [false, true]) for (const currency of ['EUR', 'USD', 'ETH', 'SOL', 'ARS', 'USDC', 'USDT']) {
    test(`O1: reviewed ${currency} survives final currency handlers (Solana connected=${connected})`, () => {
        const select = { value: currency, options: ['EUR', 'USD', 'ETH', 'ARS', 'USDC', 'USDT'].map(value => ({ value })),
            insertBefore(option) { this.options.unshift(option); } };
        const c = browser({ document: { getElementById: id => id === 'proposalCurrency' ? select : null, createElement: () => ({}) },
            solanaWalletManager: { getState: () => ({ status: connected ? 'connected' : 'disconnected', accounts: connected ? ['fictional-wallet'] : [] }) } });
        load(c, 'proposals/chain.js');
        vm.runInContext('clearProposalBalanceWatcher = () => {}; ensureProposalOfferBalanceElement = () => null;', c);
        c.attachProposalCurrencyHandlers();
        assert.equal(select.value, currency);
        assert.ok(select.options.some(o => o.value === 'ETH'));
        if (connected) assert.ok(select.options.some(o => o.value === 'SOL'));
    });
}
test('O1/O2: terms-only fork preserves implicit transfer, nondefault terms, source and reload', () => {
    const c = ownershipContext();
    load(c, 'proposals/authored-record.js'); load(c, 'proposals/formation-depth.js'); load(c, 'proposals/site-draft.js');
    load(c, 'proposal-editor-adapters.js'); load(c, 'proposal-drafts.js');
    const original = source(), before = JSON.stringify(original);
    const adapter = c.proposalEditorAdapterRegistry.get('buildings');
    const draft = adapter.draftFromProposal(original);
    assert.equal(draft.fields.ownership, 'to-me');
    draft.fields.offer = 150000; draft.fields.offerCurrency = 'EUR';
    const data = new Map();
    const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
    const store = c.createProposalDraftStore({ storage, idFactory: () => 'fork' });
    store.createDraft({ ...draft, goal: 'buildings', sourceProposalId: original.proposalId, sourceSnapshot: original }); store.flush();
    const restored = c.createProposalDraftStore({ storage }).getDraft('fork');
    assert.equal(restored.fields.offerCurrency, 'EUR'); assert.equal(restored.fields.offer, 150000);
    for (const key of ['depositEnabled', 'depositPercent', 'decayEnabled', 'decayPercent', 'decayDurationMs', 'isConditional']) assert.equal(restored.fields[key], original[key], key);
    assert.deepEqual(plain(restored.fields.approvalConfig), original.approvalConfig);
    assert.deepEqual(plain(restored.sourceSnapshot), original);
    const serialized = adapter.serializeProposal(restored);
    assert.equal(serialized.offerCurrency, 'EUR'); assert.equal(serialized.offer, 150000);
    assert.equal(serialized.facets.ownership, 'to-me');
    assert.equal(JSON.stringify(original), before);
});
test('O2: explicit retained/proposer/public intents override stale destination, unknown stays unknown', () => {
    const c = ownershipContext();
    const intent = p => plain(c.__ownershipFlow.ownershipIntent(p));
    assert.deepEqual(intent({ goal: 'buildings' }), { mode: 'to-me', destination: 'proposer', transfer: true });
    assert.deepEqual(intent({ goal: 'buildings', isVote: true }), { mode: 'no-change', destination: 'retained', transfer: false });
    for (const [mode, destination] of [['no-change', 'retained'], ['to-me', 'proposer'], ['to-city', 'public']]) {
        assert.equal(intent({ goal: 'buildings', facets: { ownership: mode } }).destination, destination);
    }
    assert.equal(intent({ goal: 'unrecognized' }).transfer, null);
    assert.equal(c.ProposalApproval.inspect(source()).ready, false);
});
test('O2: parcel comparison cannot display vote-only consent for an explicit transfer', () => {
    const turf = require('../frontend/vendor/turf-6.5.0/turf.min.js');
    const c = ownershipContext({ turf }); load(c, 'proposals/parcel-compare.js');
    const p = { ...source(), facets: { ownership: 'to-me' }, isVote: true, ownershipFlow: [{ parcelId: 'HR-339164-2536', destination: 'proposer', cededM2: 258 }] };
    const result = c.__parcelCompare.parcelEffect(p, { id: 'HR-339164-2536', feature: turf.feature(polygon), areaM2: 440 }, { channel: 'vote' });
    assert.equal(result.ownership.destination, 'proposer');
    assert.equal(result.consent.channel, 'acceptance');
    assert.equal(result.consent.rightsResolved, false);
    const retained = c.__parcelCompare.parcelEffect({ ...p, facets: { ownership: 'no-change' } }, { id: 'HR-339164-2536', feature: turf.feature(polygon), areaM2: 440 }, { channel: 'acceptance' });
    assert.equal(retained.ownership.destination, 'retained'); assert.equal(retained.consent.channel, 'vote'); assert.equal(retained.consent.needed, false);
});
test('O3: local and on-chain save labels distinguish audience and immutable replacement', () => {
    const c = browser(); load(c, 'proposals/create.js');
    const t = (key, fallback) => fallback;
    assert.match(c.proposalSaveActionLabel({ replacement: true, onchain: false }, t), /local counterproposal/i);
    assert.match(c.proposalSaveActionLabel({ isVote: true, onchain: false }, t), /local vote/i);
    assert.match(c.proposalSaveActionLabel({ replacement: true, onchain: true }, t), /replacement/i);
    assert.match(c.proposalSaveActionLabel({ isVote: true, onchain: true }, t), /voting/i);
});

test('O4: New Game cancellation leaves local records and simulation unchanged', async () => {
    let mutations = 0;
    const c = browser({ document: { readyState: 'loading', addEventListener() {} },
        AgentActionEngine: { createActivitySource: () => ({}) },
        CbDialog: { confirm: async () => false }, proposalStorage: { clear: () => mutations++ } });
    load(c, 'game.js');
    vm.runInContext('gameState.reset = () => { throw new Error("reset must not execute"); };', c);
    await c.resetGameState(); assert.equal(mutations, 0);
});
test('O4: simulation setup opens its section and describes fictional ownership without granting rights', () => {
    const status = {}, section = {}, checkbox = { checked: true };
    const c = browser({ document: { readyState: 'loading', addEventListener() {}, getElementById: id => id === 'simulation-mode-status' ? status : id === 'gameCheckbox' ? checkbox : null },
        AgentActionEngine: { createActivitySource: () => ({}) }, MapShell: { revealSection: () => section } });
    load(c, 'game.js'); assert.equal(c.showSimulationSetup(), true); assert.equal(section.open, true);
    assert.match(status.textContent, /fictional ownership/);
    assert.equal(c.ProposalApproval, undefined);
});
test('O4: confirmed New Game clears disclosed local data but preserves drafts, map and current identity', async () => {
    const saved = new Map([['parcel_fictional_owner', 'fictional-agent'], ['consensus_game_state', 'progress'], ['editor-drafts', 'kept'], ['map-cache', 'kept'], ['local-proposals', 'deleted']]);
    let agents = [{ id: 'fictional-agent', name: 'Fictional owner', avatarIndex: 2 }];
    const c = browser({ document: { readyState: 'loading', addEventListener() {} }, AgentActionEngine: { createActivitySource: () => ({}) },
        CbDialog: { confirm: async message => { assert.match(message, /deletes local proposals/); return true; } },
        PersistentStorage: { ensureReady() {}, get length() { return saved.size; }, key: i => [...saved.keys()][i], removeItem: k => saved.delete(k) },
        agentStorage: { clear: () => { agents = []; }, addAgent: a => agents.push(a) }, getCurrentUserAgent: () => agents[0],
        proposalStorage: { clear: () => saved.delete('local-proposals') } });
    load(c, 'game.js');
    vm.runInContext('stopGameLoop = () => {}; gameState.addLogEntry = () => {}; gameState.updateGameUI = () => {}; updateAgentsButton = () => {};', c);
    await c.resetGameState();
    assert.equal(saved.has('parcel_fictional_owner'), false); assert.equal(saved.has('consensus_game_state'), false); assert.equal(saved.has('local-proposals'), false);
    assert.equal(saved.get('editor-drafts'), 'kept'); assert.equal(saved.get('map-cache'), 'kept');
    assert.equal(agents.length, 1); assert.equal(agents[0].id, 'fictional-agent'); assert.equal(agents[0].name, 'Fictional owner');
    assert.equal(agents[0].ethBalance, 100); assert.deepEqual(plain(agents[0].walletAddresses), []);
});

test('O4: isolated signed fictional owner can accept, withdraw and accept an alternative after reload', () => {
    const c = ownershipContext(), A = c.ProposalApproval;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const verify = (p, receipt) => receipt.providerId === 'fixture-only' && crypto.verify(null, Buffer.from(JSON.stringify(A.decisionContent(p, receipt))), publicKey, Buffer.from(receipt.decisionProof, 'base64'));
    const p = source(); p.approvalConfig.rights = { schema: 'parcel-rights/v1', source: { provider: 'fictional-test', reference: 'no-real-title' },
        parcels: [{ parcelId: 'HR-339164-2536', complete: true, areaM2: 440, owners: [{ ownerId: 'fixture-owner', share: '1/1' }] }] };
    const original = JSON.stringify(p);
    function decide(proposal, effectHash, withdraw = false, overrides = {}) {
        const contextHash = A.contextHash(proposal);
        const args = { ownerId: 'fixture-owner', actorId: 'fictional-actor', effectHash, acceptedAt: '2026-10-16T12:00:00Z', withdraw,
            evidence: { rights: { contextHash, member: 'fixture-lens', evidenceRef: 'fictional-rights' },
                authority: { contextHash, member: 'fixture-lens', evidenceRef: 'fictional-authority', ownerId: 'fixture-owner', actorId: 'fictional-actor' } },
            providerId: 'fixture-only', ...overrides };
        args.decisionProof = crypto.sign(null, Buffer.from(JSON.stringify(A.decisionContent(proposal, { ...args, decision: withdraw ? 'withdraw' : 'approve' }))), privateKey).toString('base64');
        return A.recordDecision(proposal, { ...args, verifyReceipt: verify });
    }
    const accepted = decide(p, 'fictional-effect-1'); assert.equal(accepted.tally.passed, true);
    const withdrawn = decide(plain(accepted.proposal), 'fictional-effect-1', true); assert.equal(withdrawn.tally.passed, false);
    const alternative = { ...plain(withdrawn.proposal), proposalId: 'fictional-alternative', sourceProposalId: p.proposalId, offer: 150000, offerCurrency: 'EUR' };
    assert.equal(decide(alternative, 'fictional-effect-2').tally.passed, true);
    assert.throws(() => decide(p, 'fictional-effect-1', false, { actorId: 'wrong-actor' }), /authority/);
    const incomplete = plain(p); incomplete.approvalConfig.rights.parcels[0].complete = false;
    assert.throws(() => decide(incomplete, 'fictional-effect-1'), /authority/);
    assert.equal(A.validOwnerIds({ ...accepted.proposal, lens: ['other-lens'] }, 'fictional-effect-1', verify).length, 0);
    assert.equal(A.validOwnerIds(accepted.proposal, 'other-effect', verify).length, 0);
    assert.equal(JSON.stringify(p), original);
});

const model = require('../frontend/js/bets/bets-model.js');
const market = require('../frontend/js/proposals/market-view.js');
test('B1: atomic stake precision and parimutuel reference/size quotes remain unchanged', () => {
    assert.equal(market.parseUsdc('0.000001'), 1n); assert.equal(market.parseUsdc('1.123456'), 1123456n);
    for (const amount of ['0', '-1', '', '0.0000001', 'NaN', '1e3']) assert.throws(() => market.parseUsdc(amount));
    assert.equal(model.payoutMultiple('yes', 300000n, 100000n), 1.07);
    assert.equal(model.payoutMultiple('no', 300000n, 100000n), 1.27);
    assert.equal(model.toWin('yes', 300000n, 100000n, 1000000n), 1076923n);
    assert.equal(model.payoutMultiple('yes', 300000n, 100000n, 10000n), 1.32);
    assert.equal(model.payoutMultiple('yes', 0n, 0n), 1);
    assert.equal(model.payoutMultiple('no', 300000n, 0n), 1.3);
    assert.equal(model.payoutMultiple('yes', 0n, 0n, 0n), null);
});
test('B2: independent pool shares retain 75% and 33.3%, with empty/one-sided states', () => {
    assert.equal(model.chance(300000n, 100000n).yes, 75);
    assert.equal(model.chance(100000n, 200000n).yes, 33.3);
    assert.equal(model.chance(0n, 0n).yes, null);
    assert.equal(model.oneSided(100000n, 0n), 'yes'); assert.equal(model.oneSided(0n, 100000n), 'no');
});
test('B3: eligibility distinguishes ownership rules, mint prerequisite, chain and terminal proposals', () => {
    const entry = require('../frontend/js/proposals/bet-entry.js'), t = (k, fallback) => fallback;
    const c = ownershipContext(); load(c, 'proposals/approval-runtime.js');
    assert.equal(entry.presentation({ approvalSetup: c.ProposalApprovalRuntime.uses(source()) }, t).disabled, true);
    assert.equal(c.ProposalApprovalRuntime.uses({ goal: 'road-track' }), false);
    assert.equal(entry.presentation({ approvalSetup: false }, t).route, 'mint');
    assert.equal(entry.presentation({ approvalSetup: false }, t).disabled, false);
    assert.equal(entry.presentation({ nftInfo: { tokenId: 'fictional', chain: 'solana-devnet' } }, t).route, 'pool');
    assert.equal(entry.presentation({ nftInfo: { tokenId: 'fictional', chain: 'ethereum' } }, t).disabled, true);
    for (const proposal of [{ supersededBy: 'new' }, { lifecycleStatus: 'Executed' }, { status: 'expired' }]) assert.equal(entry.presentation({ proposal }, t).route, 'closed');
});

class Element {
    constructor() { this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.listeners = {}; this.isConnected = true; this._text = ''; }
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.append(node); return node; }
    replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(n => n.textContent || '').join(''); }
    setAttribute(k, v) { this.attributes[k] = v; }
    addEventListener(k, f) { this.listeners[k] = f; }
    focus() {}
    querySelector(selector) { const key = selector.slice(1, -1); for (const child of this.children) { if (key in child.attributes) return child; const nested = child.querySelector(selector); if (nested) return nested; } return null; }
}
test('B1: disconnected stake form previews before wallet; invalid/closed/superseded submissions never transact', async () => {
    let connects = 0, stakes = 0, connected = false;
    const c = browser({ document: { createElement: () => new Element() }, BetsModel: model, ProposalMarketView: market,
        handleWalletButtonClick: () => connects++, solanaWalletManager: { getState: () => ({ status: connected ? 'connected' : 'disconnected', accounts: connected ? ['fictional'] : [] }) },
        SolanaMarketBridge: { stake: () => { stakes++; throw new Error('No real transactions'); } } });
    const source = read('frontend/js/bets/bets-dialog.js').replace('root.BetsDialog =', 'root.__betTest = { state, renderStake, submitStake }; root.BetsDialog =');
    vm.runInContext(source, c);
    const parts = Object.fromEntries(['.bets-dialog', '.cb-dialog__title', '.cb-dialog__body', '.cb-dialog__footer'].map(k => [k, new Element()]));
    const h = c.__betTest; h.state.overlay = { querySelector: key => parts[key] }; h.state.proposalAccount = 'fictional';
    h.state.row = { state: 'open', marketAddress: 'fictional-pool', yesPoolAtomic: 300000n, noPoolAtomic: 100000n };
    h.renderStake(1);
    const body = parts['.cb-dialog__body'], footer = parts['.cb-dialog__footer'];
    const input = body.querySelector('[data-market-amount]'), submit = footer.querySelector('[data-market-submit]');
    assert.equal(connects, 0); assert.match(body.textContent, /1.076923 USDC/); assert.match(body.textContent, /includes your stake/);
    assert.match(submit.textContent, /Bet yes/);
    input.value = '0.01'; input.listeners.input(); assert.match(body.textContent, /1.32/);
    input.value = '0'; input.listeners.input(); assert.equal(submit.disabled, true);
    await h.submitStake(1); assert.equal(connects, 0); assert.equal(stakes, 0);
    input.value = '0.000001'; input.listeners.input(); assert.equal(submit.disabled, false);
    await h.submitStake(1); assert.equal(connects, 1); assert.equal(input.value, '0.000001'); assert.equal(stakes, 0);
    connected = true; h.state.row.state = 'closed'; await h.submitStake(1); assert.equal(stakes, 0);
    h.state.row.state = 'open'; h.state.row.superseded = true; await h.submitStake(1); assert.equal(stakes, 0);
});
test('all added locale keys and interpolations agree in English, Croatian, Spanish and Serbian', () => {
    const locales = ['en', 'hr', 'es', 'sr'].map(code => JSON.parse(read(`frontend/i18n/${code}.json`)));
    const baseline = locales[0].ownerAudit;
    for (const locale of locales) {
        assert.deepEqual(Object.keys(locale.ownerAudit).sort(), Object.keys(baseline).sort());
        for (const key of Object.keys(baseline)) assert.deepEqual((locale.ownerAudit[key].match(/\{\{\w+\}\}/g) || []).sort(), (baseline[key].match(/\{\{\w+\}\}/g) || []).sort());
        assert.ok(locale.proposalDrafts.review.localNotice); assert.ok(locale.proposalDrafts.actions.saveLocalCounterproposal);
    }
});
