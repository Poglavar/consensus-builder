// Unit tests for frontend/js/agreement-panel.js and agreement-list.js: the pure helpers that word an
// agreement in its docked panel and in the Agreements list (status, land, allocations, ledger, rule,
// title, list rows, and once proposed its CID, link, index status and decision slot), over hand-made
// records, a stubbed ground check and the real AgreementRecord ledger; and its "On chain" section
// (M3): only a binding agreement has one (Mint, or the account's status, decision and escrow with the
// actions its state allows, from AgreementBridge.chainActions), a vote gets one line instead; and the
// rows of the Minted agreements dialog.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const panel = require('../../frontend/js/agreement-panel.js');
const list = require('../../frontend/js/agreement-list.js');
const record = require('../../frontend/js/agreement-record.js');
const format = require('../../frontend/js/format.js');
const bridge = require('../../frontend/js/solana/agreement-bridge.js');
const client = require('../../frontend/js/solana/agreement-client.js');
const PlanRecord = require('../../frontend/js/plan-record.js');
const Cid = require('../../frontend/js/cid.js');

// A translator that shows which key was asked for, and with what count.
const keys = (key, _fallback, params = {}) => (params.count === undefined ? key : `${key}#${params.count}`);

function rect(x0, y0, x1, y1) {
    const at = (x, y) => [15.96 + x * 1e-3, 45.8 + y * 1e-3];
    return { type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] };
}
const ana = { ownerKey: 'agent-ana', displayName: 'Ana', share: 1 };
const boris = { ownerKey: 'agent-boris', displayName: 'Boris', share: 1 };

function output(pieceId, geometry, areaM2, holders, fromParcelIds = ['k9']) {
    return { hash: record.outputHash(geometry), pieceId, areaM2, fromParcelIds, producedBy: 'layout-1', role: 'plot', holders, geometry };
}

// A layout over k9 (Ana's) and k10 (Boris's): four pieces with one explicit recipient each.
function agreement(overrides = {}) {
    const outputs = [
        output('k9-p1', rect(0, 0, 1, 2), 400, [ana]),
        output('k9-p2', rect(1, 0, 3, 2), 300, [ana]),
        output('k10-p1', rect(3, 0, 4, 2), 200, [boris], ['k10']),
        output('k10-p2', rect(4, 0, 5, 2), 100, [], ['k10'])
    ];
    const designCids = ['bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'];
    const planContent = PlanRecord.create('Courtyard plan', designCids, { at: '45.8,15.96,16', mode: '2d' });
    const raw = {
        schema: 'agreement/v1',
        id: 'ag-1',
        title: null,
        city: 'zagreb',
        createdAt: '2026-10-21T10:00:00.000Z',
        updatedAt: '2026-10-21T10:00:00.000Z',
        designs: [{ proposalId: 'layout-1', title: 'Courtyard layout', goal: 'parcel-layout', cid: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' }],
        plan: { cid: Cid.cidOfObject(planContent), content: planContent },
        inputs: {
            parcels: [{ parcelId: 'k9', areaM2: 700, holders: [ana] }, { parcelId: 'k10', areaM2: 300, holders: [boris] }],
            openGroundM2: 0
        },
        outputs,
        allocations: [
            { output: outputs[0].hash, to: { kind: 'public' } },
            { output: outputs[1].hash, to: { kind: 'party', ownerKey: 'agent-boris' } },
            { output: outputs[2].hash, to: { kind: 'party', ownerKey: 'agent-ana' } },
            { output: outputs[3].hash, to: { kind: 'party', ownerKey: 'agent-ana' } }
        ],
        money: { currency: 'EUR', lines: [] },
        rule: { electorate: 'owners', binding: true, approvalConfig: null, lens: [] },
        deadline: null,
        ...overrides
    };
    return overrides.rule === null ? raw : record.settle(raw);
}

describe('statusOf', () => {
    it('says the agreement matches the map when the check is current', () => {
        expect(panel.statusOf({ current: true, reasons: [] })).toEqual({ current: true, tone: 'success', label: 'Matches the map', reasons: [] });
    });

    it('says why it no longer matches, each reason once, and leaves out codes it does not know', () => {
        const status = panel.statusOf({
            current: false,
            reasons: [
                { code: 'design-changed', proposalId: 'p-1' }, { code: 'design-changed', proposalId: 'p-1' },
                { code: 'design-changed', proposalId: 'p-2' }, { code: 'ground-changed' }, { code: 'something-new' }
            ]
        });
        expect(status).toMatchObject({ current: false, tone: 'warning', label: 'No longer matches the map' });
        expect(status.reasons).toEqual([
            { code: 'design-changed', proposalId: 'p-1', text: 'a design changed' },
            { code: 'design-changed', proposalId: 'p-2', text: 'a design changed' },
            { code: 'ground-changed', proposalId: null, text: 'the ground changed' }
        ]);
        expect(panel.statusOf({ current: false, reasons: [{ code: 'design-missing', proposalId: 'p-3' }, { code: 'design-not-applied', proposalId: 'p-4' }] }, keys).reasons
            .map(reason => reason.text)).toEqual(['agreement.panel.status.reasons.designMissing', 'agreement.panel.status.reasons.designNotApplied']);
    });

    it('never calls an unchecked agreement current', () => {
        expect(panel.statusOf(null).current).toBe(false);
        expect(panel.statusOf({ reasons: [] }).current).toBe(false);
    });
});

describe('landSummary', () => {
    it('counts the input parcels, adds their area and counts the resulting pieces', () => {
        expect(panel.landSummary(agreement())).toEqual({ parcels: 2, areaM2: 1000, pieces: 4, openGroundM2: 0 });
    });

    it('leaves the area unknown, never 0, when one input area is unknown', () => {
        const unknown = agreement();
        unknown.inputs.parcels[1].areaM2 = null;
        expect(panel.landSummary(unknown).areaM2).toBeNull();
        expect(panel.landSummary(null)).toEqual({ parcels: 0, areaM2: 0, pieces: 0, openGroundM2: null });
    });
});

describe('allocationLines', () => {
    it('words the explicit recipient of each piece', () => {
        const lines = panel.allocationLines(agreement());
        expect(lines.map(line => line.label)).toEqual(['Piece 1', 'Piece 2', 'Piece 3', 'Piece 4']);
        expect(lines.map(line => line.kind)).toEqual(['public', 'party', 'party', 'party']);
        expect(lines.map(line => line.to)).toEqual(['Public', 'Boris', 'Ana', 'Ana']);
        expect(lines[0].area).toBe(format.formatArea(400));
        expect(lines[0].hash).toBe(agreement().outputs[0].hash);
    });

    it('names the holders a piece keeps when no line allocates it', () => {
        const lines = panel.allocationLines(agreement({ allocations: [] }), keys);
        expect(lines[0].kind).toBe('holders');
        expect(lines[0].to).toBe('agreement.allocation.holders (Ana 100%)');
        expect(lines[3].to).toBe('agreement.land.unowned');
        expect(lines[0].label).toBe('agreement.land.piece 1');
    });
});

describe('ledgerRows', () => {
    it('shows each party\'s contribution, receipt, signed net change and cash, the public last', () => {
        const rows = panel.ledgerRows({
            parties: [
                { ownerKey: 'agent-ana', displayName: 'Ana', contributedM2: 700, assignedM2: 100, changeM2: -600, cashCents: 100050 },
                { ownerKey: 'agent-boris', displayName: 'Boris', contributedM2: 300, assignedM2: 450, changeM2: 150, cashCents: -2500 },
                { ownerKey: 'agent-ceca', displayName: '', contributedM2: 0, assignedM2: 0, changeM2: 0, cashCents: 0, areaUnknown: true }
            ],
            publicM2: 400,
            // A London agreement: its cash is shown in its own money.
            currency: 'GBP'
        });
        expect(rows.map(row => row.name)).toEqual(['Ana', 'Boris', 'agent-ceca', 'Public']);
        expect(rows[0]).toMatchObject({ contributes: format.formatArea(700), receives: format.formatArea(100), change: `−${format.formatArea(600)}` });
        expect(rows[0].cash).toBe(`+${format.formatMoney(1000.5, 'GBP', { maxFractionDigits: 2, minFractionDigits: 2 })}`);
        expect(rows[1]).toMatchObject({ change: `+${format.formatArea(150)}`, cash: `−${format.formatMoney(25, 'GBP', { maxFractionDigits: 0, minFractionDigits: 0 })}` });
        // An unknown input area has no contribution or change to show; no cash is no line.
        expect(rows[2]).toMatchObject({ contributes: '—', change: '—', cash: '—' });
        expect(rows[3]).toMatchObject({ ownerKey: null, contributes: '—', receives: format.formatArea(400), cash: '—' });
        expect(panel.ledgerRows(null)).toEqual([]);
    });

    it('shows proposer acquisition land and its balancing cash in saved agreement rows', () => {
        const rows = panel.ledgerRows({ parties: [], proposerM2: 2000, publicM2: 0, currency: 'EUR', money: { sponsorCents: -20000000 } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ name: 'Proposer', contributes: format.formatArea(0), receives: format.formatArea(2000),
            cash: `−${format.formatMoney(200000, 'EUR', { maxFractionDigits: 0, minFractionDigits: 0 })}` });
        const raw = agreement(); raw.allocations[0].to = { kind: 'proposer' };
        expect(panel.allocationLines(raw)[0]).toMatchObject({ kind: 'proposer', to: 'Proposer' });
    });

    it('reads the ledger AgreementRecord computes', () => {
        const rows = panel.ledgerRows(record.ledger(agreement()));
        expect(rows.map(row => row.name)).toEqual(['Ana', 'Boris', 'Public']);
        // Ana put in k9 (700 m²) and receives half of piece 3; Boris put in k10 and receives piece 2
        // and the other half of piece 3; piece 1 goes to the public.
        expect(rows[0]).toMatchObject({ contributes: format.formatArea(700), receives: format.formatArea(300), change: `−${format.formatArea(400)}` });
        expect(rows[1]).toMatchObject({ contributes: format.formatArea(300), receives: format.formatArea(300), change: format.formatArea(0), cash: '—' });
        expect(rows[2].receives).toBe(format.formatArea(400));
    });
});

describe('the rule, the title and the designs', () => {
    it('words who decides and whether it binds', () => {
        expect(panel.ruleSummary({ electorate: 'owners', binding: true }, keys, () => 'the approval rule')).toEqual({
            electorate: 'agreement.rule.electorate.owners', binding: 'agreement.rule.binding', detail: 'the approval rule'
        });
        expect(panel.ruleSummary({ electorate: 'community', binding: false }, keys, () => 'never asked')).toEqual({
            electorate: 'agreement.rule.electorate.community', binding: 'agreement.rule.nonBinding', detail: ''
        });
        expect(panel.ruleShort({ electorate: 'owners', binding: true })).toBe('Decided by the owners · Binding');
        expect(panel.ruleShort({ electorate: 'owners', binding: false })).toBe('Decided by the owners · Non-binding');
        expect(panel.ruleShort({ electorate: 'community', binding: false })).toBe('Decided by a community vote · Non-binding');
    });

    it('titles an untitled agreement by the day it was created', () => {
        expect(panel.titleOf(agreement({ title: '  Block 7  ' }))).toBe('Block 7');
        expect(panel.titleOf(agreement())).toBe(`Agreement of ${format.formatDate('2026-10-21T10:00:00.000Z')}`);
        expect(panel.titleOf(agreement({ createdAt: null }))).toBe('Agreement');
    });

    it('lists the designs as this browser holds them: a deleted one cannot be selected', () => {
        const held = { 'layout-1': { proposalId: 'layout-1', goal: 'parcel-layout', applied: true } };
        const rows = panel.designRows(agreement({ designs: [
            { proposalId: 'layout-1', title: 'Courtyard layout', goal: 'parcel-layout' },
            { proposalId: 'road-9', title: null, goal: 'road-track' }
        ] }), { designOf: id => held[id] || null, isApplied: r => r.applied === true, typeLabel: r => `type:${r.goal}` });
        expect(rows).toEqual([
            { proposalId: 'layout-1', title: 'Courtyard layout', type: 'type:parcel-layout', missing: false, applied: true },
            { proposalId: 'road-9', title: 'Untitled design', type: 'type:road-track', missing: true, applied: false }
        ]);
    });

    it('asks for the stored inputs and everything the designs held here take now', () => {
        const fabric = { producedBy: id => (id === 'road-1' ? [{ properties: { cadastreParcelIds: ['k12', 'k10'] } }] : []) };
        const ids = panel.groundIds(agreement(), [{ proposalId: 'layout-1', cadastreParcelIds: ['k9'] }, { proposalId: 'road-1', cadastreParcelIds: [] }], fabric);
        expect(ids).toEqual(['k9', 'k10', 'k12']);
    });
});

describe('panel HTML', () => {
    it('shows the status with the reasons and the design they name, or that it is still reading', () => {
        const stale = panel.statusHtml({
            status: panel.statusOf({ current: false, reasons: [{ code: 'design-changed', proposalId: 'layout-1' }, { code: 'ground-changed' }] }),
            designTitles: new Map([['layout-1', 'Courtyard <layout>']])
        });
        expect(stale).toContain('data-agreement-status="stale"');
        expect(stale).toContain('cb-badge--warning');
        expect(stale).toContain('a design changed (Courtyard &lt;layout&gt;); the ground changed');
        expect(panel.statusHtml({ checking: true })).toContain('Reading the land under the designs…');
        expect(panel.statusHtml({ error: 'offline' })).toContain('The agreement could not be checked against the map: offline');
    });

    it('offers Before / after only for an agreement that matches the map', () => {
        expect(panel.actionsHtml({ canCompare: false })).toMatch(/data-agreement-action="compare" aria-pressed="false" disabled/);
        expect(panel.actionsHtml({ canCompare: true, comparing: true })).toMatch(/data-agreement-action="compare" aria-pressed="true">/);
        expect(panel.actionsHtml()).toContain('data-agreement-action="edit"');
        expect(panel.actionsHtml()).toMatch(/class="btn btn-quiet" data-agreement-action="delete"/);
    });

    it('offers Propose only for a current agreement not yet proposed, and no Edit once proposed', () => {
        const draft = panel.actionsHtml({ canCompare: true, canPropose: true });
        expect(draft).toMatch(/class="btn btn-primary" data-agreement-action="propose"/);
        // Propose takes the main place; Before / after steps back beside it.
        expect(draft).toMatch(/class="btn" data-agreement-action="compare"/);
        expect(draft).toContain('data-agreement-action="edit"');
        expect(panel.actionsHtml({ canCompare: true })).not.toContain('data-agreement-action="propose"');
        // A proposed agreement is immutable: a change is a new agreement.
        const proposed = panel.actionsHtml({ canCompare: true, published: true });
        expect(proposed).not.toContain('data-agreement-action="propose"');
        expect(proposed).not.toContain('data-agreement-action="edit"');
        expect(proposed).toMatch(/class="btn btn-primary" data-agreement-action="compare"/);
        expect(proposed).toContain('data-agreement-action="delete"');
    });

    it('renders a secondary-tab agreement as content only, without edit, delete, chain, vote or design actions', () => {
        const actions = panel.actionsHtml({ published: true, readOnly: true, canCompare: true, canBet: true });
        expect(actions).toContain('data-agreement-action="compare" aria-pressed="false" disabled');
        expect(actions).not.toContain('data-agreement-action="edit"');
        expect(panel.actionsHtml({ readOnly: true })).not.toContain('data-agreement-action="edit"');
        expect(actions).not.toContain('data-agreement-action="delete"');
        expect(actions).not.toContain('data-agreement-action="bet"');
        expect(panel.publishedHtml({ published: PUBLISHED, readOnly: true })).toContain('data-agreement-read-only');
        expect(panel.publishedHtml({ published: PUBLISHED, readOnly: true })).not.toContain('data-approval-card-slot');
        expect(panel.designsHtml([{ proposalId: 'd1', title: 'Layout', type: 'Layout', missing: false }], undefined, true))
            .toContain('data-agreement-design="d1" disabled');
        expect(panel.chainHtml({ published: true, readOnly: true, ref: null, actions: { canMint: true } }))
            .not.toContain('data-agreement-action="mint"');
    });

    it('opens an in-memory published record without reading or writing the local agreement store', async () => {
        const panelBody = { innerHTML: '' };
        const title = { textContent: '' };
        const closeButton = { setAttribute: vi.fn(), title: '' };
        const panelNode = {
            classList: { values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); }, contains(value) { return this.values.has(value); } },
            addEventListener: vi.fn(), setAttribute: vi.fn(),
            querySelector: selector => selector === '#agreement-panel-title' ? title
                : selector === '.agreement-panel-kind' ? { textContent: '' }
                : selector === '[data-agreement-action="close"]' ? closeButton
                    : selector === '[data-agreement-region="body"]' ? panelBody : null
        };
        const doc = {
            body: { appendChild: vi.fn(), classList: { add: vi.fn(), remove: vi.fn() } },
            addEventListener: vi.fn(), getElementById: () => null, createElement: () => panelNode
        };
        const store = { get: vi.fn(() => { throw new Error('read-only view must not read local storage'); }), save: vi.fn(), subscribe: vi.fn() };
        const approval = { setStatus: vi.fn(), sync: vi.fn(), render: vi.fn() };
        const win = {
            document: doc,
            AgreementStore: store,
            AgreementRecord: record,
            AgreementDialog: { sponsorLine: () => null, inputParcelIds: () => [], originalsById: () => [] },
            NamedPlans: { link: cid => `/plans/${cid}` },
            AgreementGround: {
                check: async () => ({ current: false, reasons: [] }), localHolders: () => () => null, areaOf: () => null
            },
            AgreementSync: { fetchAgreement: async () => ({ status: 'active' }) },
            ProposalApprovalPanel: approval,
            ProposalBeforeAfter: { agreementKey: id => id, isActive: () => false },
            CbFormat: format,
            proposalStorage: { getProposal: () => null },
            CadastralParcelRepository: { ensureIds: async () => ({ features: [] }) },
            LiveParcelFabric: {},
            isApplied: () => false,
            PersistentStorage: {}, agentStorage: {}
        };
        const viewRecord = record.normalize(agreement({ title: 'Read-only view', published: PUBLISHED,
            rule: { electorate: 'owners', binding: false, approvalConfig: null, lens: [] } }));
        const browser = panel.browserPanel(win);

        await browser.openReadOnly(viewRecord);
        await Promise.resolve();
        await Promise.resolve();

        expect(browser.current()).toBe(viewRecord.id);
        expect(store.get).not.toHaveBeenCalled();
        expect(store.save).not.toHaveBeenCalled();
        expect(title.textContent).toBe('Read-only view');
        expect(panelBody.innerHTML).toContain('data-agreement-read-only');
        expect(panelBody.innerHTML).toContain('data-agreement-read-only-status');
        expect(panelBody.innerHTML).toContain(`/plans/${viewRecord.plan.cid}`);
        expect(panelBody.innerHTML).toContain('Designs in this plan');
        expect(panelBody.innerHTML).not.toContain('Reading the land under the designs');
        expect(panelBody.innerHTML).not.toContain('data-agreement-action="edit"');
        expect(panelBody.innerHTML).not.toContain('data-agreement-action="delete"');
        expect(panelBody.innerHTML).not.toContain('data-approval-card-slot');
        expect(approval.sync).not.toHaveBeenCalled();
        expect(approval.render).not.toHaveBeenCalled();
    });

    it('words what the index says of a proposed agreement', () => {
        expect(panel.remoteStatusOf(null)).toEqual({ tone: 'neutral', label: 'Checking the server…' });
        expect(panel.remoteStatusOf({ loading: true, status: 'active' })).toMatchObject({ tone: 'neutral' });
        expect(panel.remoteStatusOf({ error: 'offline' })).toEqual({ tone: 'warning', label: 'Server status unavailable: offline' });
        expect(panel.remoteStatusOf({ status: 'expired' })).toEqual({ tone: 'danger', label: 'Expired' });
        expect(panel.remoteStatusOf({ status: 'active' })).toEqual({ tone: 'success', label: 'Active' });
    });

    it('shows a proposed agreement by its CID with its link and status, and where its parties decide', () => {
        const cid = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
        const published = { cid, publishedAt: '2026-10-21T12:00:00.000Z', apiBase: 'https://api.example.test' };
        expect(panel.publishedHtml({ published: null })).toBe('');
        const owners = panel.publishedHtml({ published, remote: { cid, status: 'active' }, electorate: 'owners' });
        expect(owners).toContain(`<code class="agreement-panel-cid" title="${cid}">${cid.slice(0, 12)}…${cid.slice(-6)}</code>`);
        expect(owners).toContain('data-agreement-action="link"');
        expect(owners).toContain('data-agreement-remote-status="active"');
        expect(owners).toContain('cb-badge--success');
        expect(owners).toContain('data-approval-card-slot');
        expect(owners).not.toContain('data-agreement-community-note');
        const community = panel.publishedHtml({ published, remote: { cid, status: 'expired' }, electorate: 'community' });
        expect(community).toContain('data-agreement-community-note');
        expect(community).toContain('Community votes are counted without a blockchain transaction.');
        expect(community).not.toContain('M3');
        expect(community).not.toContain('data-approval-card-slot');
        expect(community).toContain('cb-badge--danger');
    });

    it('makes every design a button that selects it, and every piece a line', () => {
        const designs = panel.designsHtml([{ proposalId: 'layout-1', title: 'Layout', type: 'Parcel layout', missing: false, applied: true },
            { proposalId: 'gone', title: 'Gone', type: '', missing: true, applied: false }]);
        expect(designs).toContain('<button type="button" class="btn btn-quiet agreement-panel-design" data-agreement-design="layout-1">');
        expect(designs).toContain('data-agreement-design="gone" disabled');
        expect(designs.match(/cb-badge--applied/g)).toHaveLength(1);
        const pieces = panel.allocationHtml(panel.allocationLines(agreement()));
        expect(pieces.match(/data-agreement-piece=/g)).toHaveLength(4);
        expect(panel.allocationHtml([])).toBe('');
    });
});

describe('Agreements list rows', () => {
    it('words a row: the title, the designs counted by the plural key, and the rule', () => {
        expect(list.rowLabel(agreement({ title: 'Block 7' }))).toEqual({ title: 'Block 7', meta: '1 design · Decided by the owners · Binding' });
        const three = agreement({ designs: ['a', 'b', 'c'].map(id => ({ proposalId: id })), rule: { electorate: 'community', binding: false } });
        expect(list.rowLabel(three).meta).toBe('3 designs · Decided by a community vote · Non-binding');
        expect(list.rowLabel(three, keys)).toEqual({
            title: 'agreement.panel.untitled',
            meta: 'agreement.list.designs#3 · agreement.rule.electorate.community · agreement.rule.nonBinding'
        });
    });

    it('starts a new agreement from every applied design held here', () => {
        const records = [{ proposalId: 1, applied: true }, { proposalId: 'p-2', applied: false }, { proposalId: 'p-3', applied: true }, null, { applied: true }];
        expect(list.appliedDesignIds(records, r => r.applied === true)).toEqual(['1', 'p-3']);
        expect(() => list.appliedDesignIds(records)).toThrow(TypeError);
    });

    it('renders one button per agreement, or says there is none yet', () => {
        const html = list.rowsHtml([agreement({ id: 'ag-"1"', title: 'A & B' })]);
        expect(html).toContain('class="btn btn-quiet agreement-item" data-agreement-id="ag-&quot;1&quot;"');
        expect(html).toContain('A &amp; B');
        expect(list.rowsHtml([])).toContain('No agreements yet. Apply designs, then create one.');
        expect(list.bodyHtml('')).toContain('<button type="button" class="btn btn-primary" data-agreement-action="create">');
        expect(list.bodyHtml('', keys)).toContain('<button type="button" class="btn btn-secondary" data-agreement-action="minted">agreement.minted.title</button>');
    });
});

// ---- On chain (M3) -------------------------------------------------------------------------------

const SPONSOR = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const OTHER_WALLET = 'HrcX5vC2ws2sKiLwpTyYG6Dnc3dmHT6zvuUp2xDs2pEx';
const LENS = 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB';
const ACCOUNT = 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W';
const CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
const PUBLISHED = { cid: CID, publishedAt: '2026-10-21T12:00:00.000Z', apiBase: 'https://api.example.test', sponsor: SPONSOR };
const NOW = 1_790_000_000;
const SOL = 1_000_000_000n;
// An agreement account as AgreementClient.readAgreement decodes it.
const account = (overrides = {}) => ({
    address: ACCOUNT, cid: CID, authority: SPONSOR, lens: LENS, payout: SPONSOR, deadline: 0, createdAt: NOW - 100,
    requiredLamports: SOL, escrowLamports: 0n, statusCode: 0, status: 'Active', openGround: false, decisionCode: 0, decision: 'Pending',
    decisionAttestedAt: 0, decisionObservedAt: 0, decisionAttestation: null, decisionHash: null, executedAt: 0, bump: 254, ...overrides
});
// The section's view as the panel builds it (chainView), unminted unless a ref is given.
const view = (overrides = {}) => ({
    published: PUBLISHED, sponsor: SPONSOR, ref: null, wallet: SPONSOR, lens: LENS, electorate: 'owners', deadlinePassed: false,
    chain: null, actions: null, attestation: null, busy: null, ...overrides
});
const minted = (value, { wallet = SPONSOR, attestation = null, ...overrides } = {}) => view({
    ref: { cluster: 'devnet', account: ACCOUNT }, wallet, attestation,
    chain: { loading: false, value, error: null },
    actions: value ? bridge.chainActions(value, { wallet, attestation, nowSeconds: NOW }) : null,
    ...overrides
});
// The data-agreement-action of every button, with whether it is disabled.
const buttons = html => [...html.matchAll(/<button type="button" class="[^"]*" data-agreement-action="([a-z]+)"( disabled)?>/g)]
    .map(match => `${match[1]}${match[2] ? ':disabled' : ''}`);

describe('On chain: who has a chain section', () => {
    it('is only a binding agreement', () => {
        expect(panel.isBinding(agreement())).toBe(true);
        expect(panel.isBinding(agreement({ rule: { electorate: 'owners', binding: false, approvalConfig: null, lens: [] } }))).toBe(false);
        expect(panel.isBinding(agreement({ rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] } }))).toBe(false);
        expect(panel.isBinding(agreement({ rule: { electorate: 'owners', binding: 'true' } }))).toBe(false);
        expect(panel.isBinding(agreement({ rule: null }))).toBe(false);
        expect(panel.isBinding(null)).toBe(false);
    });

    it('a proposed vote says in one line that it is counted off-chain, and a draft says nothing', () => {
        const line = panel.nonBindingChainHtml(PUBLISHED);
        expect(line).toContain('data-agreement-chain="non-binding"');
        expect(line).toContain('A vote is not minted; its decisions are counted off-chain.');
        expect(line).not.toContain('data-agreement-action');
        expect(panel.nonBindingChainHtml(null)).toBe('');
        expect(panel.chainHtml(view({ published: null }))).toBe('');
        expect(panel.chainHtml(null)).toBe('');
    });
});

describe('On chain: minting', () => {
    it('is ready only for the sponsor\'s wallet, a lens and a deadline still ahead', () => {
        expect(panel.mintReadiness({ sponsor: SPONSOR, wallet: SPONSOR, lens: LENS })).toEqual({ canMint: true, repropose: false, canRepropose: false, hints: [] });
        const hints = options => panel.mintReadiness({ sponsor: SPONSOR, wallet: SPONSOR, lens: LENS, ...options }, keys).hints;
        expect(hints({ wallet: null })).toEqual(['agreement.chain.hints.connectSponsor']);
        expect(hints({ wallet: OTHER_WALLET })).toEqual(['agreement.chain.hints.notSponsor']);
        expect(hints({ lens: null })).toEqual(['agreement.chain.hints.noRuleLens']);
        expect(hints({ lens: null, electorate: 'community' })).toEqual(['agreement.chain.hints.noConfiguredLens']);
        expect(hints({ deadlinePassed: true })).toEqual(['agreement.chain.hints.deadlinePassed']);
        expect(hints({ wallet: OTHER_WALLET, lens: null, deadlinePassed: true }))
            .toEqual(['agreement.chain.hints.notSponsor', 'agreement.chain.hints.noRuleLens', 'agreement.chain.hints.deadlinePassed']);
        expect(panel.mintReadiness({ sponsor: SPONSOR, wallet: OTHER_WALLET, lens: LENS }).hints[0])
            .toBe(`Only the sponsor’s wallet (${panel.shortKey(SPONSOR)}) can mint it; the connected wallet is ${panel.shortKey(OTHER_WALLET)}.`);
    });

    it('an agreement proposed without a sponsor can only be proposed again, which needs a wallet', () => {
        expect(panel.mintReadiness({ sponsor: null, wallet: SPONSOR, lens: LENS }, keys))
            .toEqual({ canMint: false, repropose: true, canRepropose: true, hints: ['agreement.chain.hints.noSponsor'] });
        expect(panel.mintReadiness({ sponsor: null, wallet: null, lens: LENS }).canRepropose).toBe(false);
    });

    it('offers Mint while unminted, disabled until it is ready, or Propose again without a sponsor', () => {
        const ready = panel.chainHtml(view());
        expect(ready).toContain('data-agreement-chain="unminted"');
        expect(buttons(ready)).toEqual(['mint']);
        expect(buttons(panel.chainHtml(view({ wallet: OTHER_WALLET })))).toEqual(['mint:disabled']);
        expect(panel.chainHtml(view({ wallet: OTHER_WALLET }))).toContain('Only the sponsor’s wallet');
        const unsponsored = view({ published: { ...PUBLISHED, sponsor: null }, sponsor: null });
        expect(buttons(panel.chainHtml(unsponsored))).toEqual(['repropose']);
        expect(buttons(panel.chainHtml({ ...unsponsored, wallet: null }))).toEqual(['repropose:disabled']);
    });

    it('locks the actions while one runs and says what it is waiting for', () => {
        const busy = panel.chainHtml(view({ busy: { action: 'mint', phase: 'awaiting_signature' } }));
        expect(buttons(busy)).toEqual(['mint:disabled']);
        expect(busy).toContain('data-agreement-chain-busy="mint"');
        expect(busy).toContain('Waiting for the wallet’s signature…');
        expect(panel.chainHtml(view({ busy: { action: 'mint', phase: 'something-else' } }))).toContain('Preparing the transaction…');
    });
});

describe('On chain: a minted agreement', () => {
    it('links the account on its cluster\'s explorer while reading it, and says when it cannot', () => {
        const loading = panel.chainHtml(view({ ref: { cluster: 'devnet', account: ACCOUNT }, chain: { loading: true } }));
        expect(loading).toContain('data-agreement-chain="loading"');
        expect(loading).toContain(`href="https://explorer.solana.com/address/${ACCOUNT}?cluster=devnet"`);
        expect(loading).toContain(`title="${ACCOUNT}">${panel.shortKey(ACCOUNT)}</a>`);
        expect(buttons(loading)).toEqual([]);
        const failed = panel.chainHtml(view({ ref: { cluster: 'devnet', account: ACCOUNT }, chain: { loading: false, error: 'rpc down' } }));
        expect(failed).toContain('data-agreement-chain="error"');
        expect(failed).toContain('The chain account could not be read: rpc down');
        const missing = panel.chainHtml(minted(null));
        expect(missing).toContain('data-agreement-chain="missing"');
        expect(missing).toContain('The account is not on Solana devnet.');
    });

    it('shows the status, decision, escrow, lens and payout the account holds', () => {
        const html = panel.chainHtml(minted(account({ escrowLamports: SOL / 2n })));
        expect(html).toContain('data-agreement-chain="minted"');
        expect(html).toContain('data-agreement-chain-status="Active"');
        expect(html).toContain('cb-badge--minted');
        expect(html).toContain('data-agreement-chain-decision="Pending"');
        const sol = value => format.formatMoney(value, 'SOL', { maxFractionDigits: 9, minFractionDigits: 0 });
        expect(html).toContain(`${sol(0.5)} of ${sol(1)}`);
        expect(html).toContain(`<code title="${LENS}">${panel.shortKey(LENS)}</code>`);
        expect(html).toContain('<dt>Deadline</dt><dd>None</dd>');
        expect(panel.chainHtml(minted(account({ requiredLamports: 0n })))).toContain(`${sol(0)} (none required)`);
        const executed = panel.chainHtml(minted(account({ statusCode: 1, status: 'Executed', decisionCode: 1, decision: 'Satisfied', escrowLamports: SOL, executedAt: NOW })));
        expect(executed).toContain('data-agreement-chain-status="Executed"');
        expect(executed).toContain('cb-badge--executed');
        expect(executed).toContain(`<dt>Executed</dt><dd>${format.formatDateTime(NOW)}</dd>`);
        // A closed agreement has nothing left to do.
        expect(buttons(executed)).toEqual([]);
        expect(buttons(panel.chainHtml(minted(account({ statusCode: 2, status: 'Cancelled' }))))).toEqual([]);
    });

    it('gives the sponsor Fund and Cancel and anyone Execute while the decision is pending', () => {
        expect(buttons(panel.chainHtml(minted(account())))).toEqual(['execute:disabled', 'fund', 'cancel']);
        const stranger = panel.chainHtml(minted(account(), { wallet: OTHER_WALLET }));
        expect(buttons(stranger)).toEqual(['execute:disabled']);
        expect(stranger).toContain('Waiting for its lens to attest the decision.');
        const disconnected = panel.chainHtml(minted(account(), { wallet: null }));
        expect(buttons(disconnected)).toEqual(['execute:disabled']);
        expect(disconnected).toContain('Connect a Solana wallet to act on it.');
    });

    it('offers Record decision once the lens has attested, and Execute once it is recorded and funded', () => {
        const attested = panel.chainHtml(minted(account(), { attestation: LENS }));
        expect(buttons(attested)).toEqual(['attest', 'execute:disabled', 'fund', 'cancel']);
        expect(attested).toContain('Its lens has attested the decision: record it on chain.');
        const satisfied = account({ decisionCode: 1, decision: 'Satisfied' });
        // Recorded but unfunded: Execute waits for the escrow; the sponsor can no longer cancel.
        const unfunded = panel.chainHtml(minted(satisfied));
        expect(buttons(unfunded)).toEqual(['execute:disabled', 'fund', 'cancel:disabled']);
        expect(unfunded).toContain(`Execution waits until the escrow holds ${format.formatMoney(1, 'SOL', { maxFractionDigits: 9, minFractionDigits: 0 })}.`);
        const funded = panel.chainHtml(minted({ ...satisfied, escrowLamports: SOL }, { wallet: OTHER_WALLET }));
        expect(buttons(funded)).toEqual(['execute']);
        expect(funded).toMatch(/class="btn btn-primary" data-agreement-action="execute"/);
    });

    it('offers Expire to anyone once the deadline has passed, and nothing that would fail', () => {
        const passed = account({ deadline: NOW - 60, decisionCode: 1, decision: 'Satisfied', escrowLamports: SOL });
        const html = panel.chainHtml(minted(passed, { wallet: OTHER_WALLET }));
        expect(buttons(html)).toEqual(['execute:disabled', 'expire']);
        expect(html).toContain('Its deadline has passed: anyone can expire it');
        expect(buttons(panel.chainHtml(minted(passed)))).toEqual(['execute:disabled', 'fund:disabled', 'cancel:disabled', 'expire']);
    });

    it('words a chain status however it is spelled', () => {
        // The index spells it 'active', the account decoder 'Active'.
        expect(['active', 'Active', 'EXECUTED', 'cancelled', 'Expired'].map(status => panel.chainStatusText(status)))
            .toEqual(['Active', 'Active', 'Executed', 'Cancelled', 'Expired']);
        expect(panel.chainStatusText('active', keys)).toBe('agreement.chain.status.active');
        expect(panel.chainStatusText('Unknown(9)')).toBe('Unknown(9)');
        expect(panel.chainStatusText(null)).toBe('');
        expect(client.STATUS_NAMES.map(status => panel.chainStatusText(status))).toEqual(['Active', 'Executed', 'Cancelled', 'Expired']);
    });

    it('shortens a key to its ends and leaves a short one whole', () => {
        expect(panel.shortKey(SPONSOR)).toBe('9xQe…VFin');
        expect(panel.shortKey('short-key')).toBe('short-key');
        expect(panel.shortKey(null)).toBe('');
    });
});

describe('the actions row of a binding agreement', () => {
    it('offers Bet only when the markets offer one, never Edit once proposed', () => {
        expect(panel.actionsHtml({ canCompare: true, published: true, canBet: true })).toMatch(/class="btn" data-agreement-action="bet"/);
        expect(panel.actionsHtml({ canCompare: true, published: true })).not.toContain('data-agreement-action="bet"');
    });
});

describe('Minted agreements rows', () => {
    // A row of GET /agreements?minted=1: the index's agreement with its chain account.
    const minted = (extra = {}) => ({
        cid: CID, title: 'Block 7', createdAt: '2026-10-21T12:00:00.000Z',
        content: { title: 'Block 7', createdAt: '2026-10-21T10:00:00.000Z', planCid: CID }, designCids: [CID, 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'],
        onchain: { chain: 'solana', cluster: 'devnet', account: ACCOUNT, status: 'active' },
        ...extra
    });

    it('words a minted agreement: its title, its designs, its status on chain and its account', () => {
        expect(list.mintedRowLabel(minted())).toEqual({ title: 'Block 7', meta: `2 designs · Active · ${panel.shortKey(ACCOUNT)}` });
        const untitled = minted({ title: null, content: { title: null, createdAt: '2026-10-21T10:00:00.000Z', planCid: CID }, designCids: [CID],
            onchain: { ...minted().onchain, status: 'executed' } });
        expect(list.mintedRowLabel(untitled)).toEqual({
            title: `Agreement of ${format.formatDate('2026-10-21T10:00:00.000Z')}`, meta: `1 design · Executed · ${panel.shortKey(ACCOUNT)}`
        });
        expect(list.mintedRowLabel(minted(), keys).meta).toBe(`agreement.list.designs#2 · agreement.chain.status.active · ${panel.shortKey(ACCOUNT)}`);
    });

    it('renders one button per minted agreement by its CID, or says none is minted yet', () => {
        const html = list.mintedRowsHtml([minted({ cid: 'bafk"<x>' }), minted()]);
        expect(html.match(/data-agreement-cid=/g)).toHaveLength(2);
        expect(html).toContain('<button type="button" class="btn btn-quiet agreement-item" data-agreement-cid="bafk&quot;&lt;x&gt;">');
        expect(html).toContain(`data-agreement-cid="${CID}"`);
        expect(html).not.toContain('data-agreement-id=');
        expect(list.mintedRowsHtml([])).toContain('No agreement of this city is minted yet.');
    });
});
