// Unit tests for frontend/js/agreement-panel.js and agreement-list.js: the pure helpers that word an
// agreement in its docked panel and in the Agreements list (status, land, allocations, ledger, rule,
// title, list rows), over hand-made records, a stubbed ground check and the real AgreementRecord ledger.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const panel = require('../../frontend/js/agreement-panel.js');
const list = require('../../frontend/js/agreement-list.js');
const record = require('../../frontend/js/agreement-record.js');
const format = require('../../frontend/js/format.js');

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

// A layout over k9 (Ana's) and k10 (Boris's): four pieces, one to the public, one to Boris, one
// jointly, one left with its holders; Ana is paid 1,000.50 EUR.
function agreement(overrides = {}) {
    const outputs = [
        output('k9-p1', rect(0, 0, 1, 2), 400, [ana]),
        output('k9-p2', rect(1, 0, 3, 2), 300, [ana]),
        output('k10-p1', rect(3, 0, 4, 2), 200, [boris], ['k10']),
        output('k10-p2', rect(4, 0, 5, 2), 100, [], ['k10'])
    ];
    return {
        schema: 'agreement/v1',
        id: 'ag-1',
        title: null,
        city: 'zagreb',
        createdAt: '2026-10-21T10:00:00.000Z',
        updatedAt: '2026-10-21T10:00:00.000Z',
        designs: [{ proposalId: 'layout-1', title: 'Courtyard layout', goal: 'parcel-layout', fingerprint: 'c2-layout' }],
        inputs: {
            parcels: [{ parcelId: 'k9', areaM2: 700, holders: [ana] }, { parcelId: 'k10', areaM2: 300, holders: [boris] }],
            openGroundM2: 12.5
        },
        outputs,
        allocations: [
            { output: outputs[0].hash, to: { kind: 'public' } },
            { output: outputs[1].hash, to: { kind: 'party', ownerKey: 'agent-boris' } },
            { output: outputs[2].hash, to: { kind: 'joint', shares: [{ ownerKey: 'agent-ana', share: 0.5 }, { ownerKey: 'agent-boris', share: 0.5 }] } }
        ],
        money: { currency: 'EUR', lines: [{ ownerKey: 'agent-ana', amountCents: 100050 }] },
        rule: { electorate: 'owners', binding: true, approvalConfig: null, lens: [] },
        deadline: null,
        ...overrides
    };
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
        expect(panel.landSummary(agreement())).toEqual({ parcels: 2, areaM2: 1000, pieces: 4, openGroundM2: 12.5 });
    });

    it('leaves the area unknown, never 0, when one input area is unknown', () => {
        const unknown = agreement();
        unknown.inputs.parcels[1].areaM2 = null;
        expect(panel.landSummary(unknown).areaM2).toBeNull();
        expect(panel.landSummary(null)).toEqual({ parcels: 0, areaM2: 0, pieces: 0, openGroundM2: null });
    });
});

describe('allocationLines', () => {
    it('words who receives each piece: the public, a party, joint shares, or the carried-over holders', () => {
        const lines = panel.allocationLines(agreement());
        expect(lines.map(line => line.label)).toEqual(['Piece 1', 'Piece 2', 'Piece 3', 'Piece 4']);
        expect(lines.map(line => line.kind)).toEqual(['public', 'party', 'joint', 'holders']);
        expect(lines.map(line => line.to)).toEqual(['Public', 'Boris', 'Ana 50%, Boris 50%', 'No recorded owner']);
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
            publicM2: 400
        });
        expect(rows.map(row => row.name)).toEqual(['Ana', 'Boris', 'agent-ceca', 'Public']);
        expect(rows[0]).toMatchObject({ contributes: format.formatArea(700), receives: format.formatArea(100), change: `−${format.formatArea(600)}` });
        expect(rows[0].cash).toBe(`+${format.formatMoney(1000.5, 'EUR', { maxFractionDigits: 2, minFractionDigits: 2 })}`);
        expect(rows[1]).toMatchObject({ change: `+${format.formatArea(150)}`, cash: `−${format.formatMoney(25, 'EUR', { maxFractionDigits: 0, minFractionDigits: 0 })}` });
        // An unknown input area has no contribution or change to show; no cash is no line.
        expect(rows[2]).toMatchObject({ contributes: '—', change: '—', cash: '—' });
        expect(rows[3]).toMatchObject({ ownerKey: null, contributes: '—', receives: format.formatArea(400), cash: '—' });
        expect(panel.ledgerRows(null)).toEqual([]);
    });

    it('reads the ledger AgreementRecord computes', () => {
        const rows = panel.ledgerRows(record.ledger(agreement()));
        expect(rows.map(row => row.name)).toEqual(['Ana', 'Boris', 'Public']);
        // Ana put in k9 (700 m²) and receives half of piece 3; Boris put in k10 and receives piece 2
        // and the other half of piece 3; piece 1 goes to the public.
        expect(rows[0]).toMatchObject({ contributes: format.formatArea(700), receives: format.formatArea(100), change: `−${format.formatArea(600)}` });
        expect(rows[1]).toMatchObject({ contributes: format.formatArea(300), receives: format.formatArea(400), change: `+${format.formatArea(100)}`, cash: '—' });
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
            { proposalId: 'road-9', title: 'Untitled proposal', type: 'type:road-track', missing: true, applied: false }
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
        expect(panel.actionsHtml()).toMatch(/class="btn btn-danger" data-agreement-action="delete"/);
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
    });
});
