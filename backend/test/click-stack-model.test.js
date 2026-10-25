// The click stack's ordering, counts, default instance, remembered section and close-or-switch rule.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const model = require('../../frontend/js/click-stack/click-stack-model.js');

it('navigates agreement → design → formed parcel → source parcel without offering selected peers', () => {
    const parcel = { id: 'p1' };
    const formed = { id: 'piece', designId: 'd1', designLabel: 'Street', feature: { properties: { cadastreParcelIds: ['p1'] } } };
    const designs = [{ id: 'd1', label: 'Street', proposal: { cadastreParcelIds: ['p1'] }, createdAt: 1 }, { id: 'd2', label: 'Park', createdAt: 2 }];
    const agreement = { id: 'a1', agreement: { designs: [{ proposalId: 'd1' }, { proposalId: 'd2' }] } };
    const hits = { agreements: [agreement], designs, formed: [formed], parcels: [parcel] };
    const links = (kind, item) => model.contextFor(kind, item, hits).map(group => [group.position, group.kind, group.instances.map(item => item.id)]);
    expect(links('agreements', agreement)).toEqual([['below', 'designs', ['d1', 'd2']]]);
    expect(links('designs', designs[0])).toEqual([['above', 'agreements', ['a1']], ['below', 'formed', ['piece']]]);
    expect(links('formed', formed)).toEqual([['above', 'designs', ['d1']], ['below', 'parcels', ['p1']]]);
    expect(links('parcels', parcel)).toEqual([['above', 'formed', ['piece']]]);
    expect(model.contextFor('formed', formed, { ...hits, designs: [] })[0].instances).toEqual([{ id: 'd1', label: 'Street' }]);
});

const kinds = stack => stack.sections.map(section => section.kind);

describe('click stack model', () => {
    it('orders agreements, plans, designs, built, permitted, formed parcel, cadastral parcels, showing only what is there', () => {
        expect(kinds(model.buildClickStack({ built: [{ id: 'b1' }], parcels: [{ id: 'p1' }] }))).toEqual(['built', 'parcels']);
        expect(kinds(model.buildClickStack({ parcels: [{ id: 'p1' }], permitted: [{ id: 'm1' }], built: [{ id: 'b1' }], formed: [{ id: 'f1' }] })))
            .toEqual(['built', 'permitted', 'formed', 'parcels']);
        expect(kinds(model.buildClickStack({ parcels: [{ id: 'p1' }], designs: [{ id: 'd1' }], built: [{ id: 'b1' }], permitted: [{ id: 'm1' }], plans: [{ id: 'pl1' }], agreements: [{ id: 'a1' }] })))
            .toEqual(['agreements', 'plans', 'designs', 'built', 'permitted', 'parcels']);
        expect(model.buildClickStack({}).sections).toEqual([]);
        expect(kinds(model.buildClickStack({ ground: [{ id: 'here' }] }))).toEqual(['ground']);
        expect(model.buildClickStack({ ground: [{ id: 'here' }] }).expanded).toBe('ground');
    });

    it('relates plans and agreements to exact design identities and labels missing members', () => {
        const d1 = { id: 'local-1', cid: 'bafy-design-one', label: 'Road' };
        const d2 = { id: 'local-2', serverId: 'server-2', label: 'Park' };
        const plan = { id: 'pl', content: { designCids: ['bafy-design-one', 'bafy-missing'] } };
        const agreement = { id: 'ag', agreement: { designs: [{ proposalId: 'local-2', title: 'Park' }] } };
        const hits = { plans: [plan], agreements: [agreement], designs: [d1, d2] };
        expect(model.contextFor('plans', plan, hits).map(group => [group.relation, group.instances.map(item => item.id)]))
            .toEqual([['includedDesigns', ['local-1', 'bafy-missing']]]);
        expect(model.contextFor('agreements', agreement, hits)[0].relation).toBe('includedDesigns');
        expect(model.contextFor('designs', d1, hits).map(group => [group.relation, group.instances.map(item => item.id)]))
            .toEqual([['memberPlans', ['pl']]]);
        expect(model.contextFor('designs', d2, hits).map(group => [group.relation, group.instances.map(item => item.id)]))
            .toEqual([['memberAgreements', ['ag']]]);
    });

    it('keeps published CID membership separate from an edited local design with the same local id', () => {
        const edited = { id: 'local-1', cid: 'bafy-new-version', label: 'Edited road' };
        const plan = { id: 'pl-old', designCids: ['bafy-old-version'] };
        const agreement = { id: 'ag-old', agreement: { designs: [{ proposalId: 'local-1', cid: 'bafy-old-version' }] } };
        const hits = { plans: [plan], agreements: [agreement], designs: [edited] };
        const planMember = model.contextFor('plans', plan, hits)[0].instances[0];
        const agreementMember = model.contextFor('agreements', agreement, hits)[0].instances[0];
        expect(planMember).toMatchObject({ id: 'bafy-old-version', serverId: 'bafy-old-version' });
        expect(agreementMember).toMatchObject({ id: 'bafy-old-version', serverId: 'bafy-old-version' });
        expect(model.contextFor('designs', edited, hits).map(group => group.kind)).toEqual([]);
    });

    it('uses a reverse-membership CID witness when a plan summary has no design list', () => {
        const current = { id: 'local-1', cid: 'bafy-current', label: 'Current revision' };
        const stale = { id: 'local-1', cid: 'bafy-stale', label: 'Stale revision' };
        const planSummary = { id: 'plan-1', membershipDesignCid: 'bafy-current', label: 'Plan' };
        const groups = model.contextFor('designs', current, { designs: [current, stale], plans: [planSummary] });
        expect(groups.map(group => [group.relation, group.instances.map(item => item.id)]))
            .toEqual([['memberPlans', ['plan-1']]]);
        expect(model.contextFor('designs', stale, { designs: [current, stale], plans: [planSummary] })).toEqual([]);
    });

    it('hides only a redundant singleton relationship to the sole identical visible target', () => {
        const design = { id: 'd1', label: 'Road' };
        const agreement = { id: 'a1', agreement: { designs: [{ proposalId: 'd1' }] } };
        const hits = { designs: [design], agreements: [agreement] };
        expect(model.contextFor('designs', design, hits).map(group => group.kind)).toEqual(['agreements']);
        expect(model.visibleContextFor('designs', design, hits)).toEqual([]);
        expect(model.visibleContextFor('designs', design, { designs: [design], agreements: [{ id: 'a2' }, agreement] }))
            .toHaveLength(1);
        // The relationship still navigates when its target isn't represented in the current stack.
        expect(model.visibleContextFor('agreements', agreement, { designs: [] })[0].instances)
            .toEqual([{ id: 'd1', label: 'd1' }]);
    });

    it('counts instances, selects the newest design and agreement first, and drops duplicates', () => {
        const stack = model.buildClickStack({
            designs: [{ id: 'old', createdAt: '2026-01-01' }, { id: 'new', createdAt: '2026-10-01' }, { id: 'old', createdAt: '2026-01-01' }],
            parcels: [{ id: 'p2' }, { id: 'p1' }]
        });
        const designs = stack.sections[0];
        expect(designs.count).toBe(2);
        expect(designs.multi).toBe(true);
        expect(designs.instances.map(item => item.id)).toEqual(['new', 'old']);
        expect(model.selectedInstance(stack, 'designs').id).toBe('new');
        expect(stack.sections[1].instances.map(item => item.id)).toEqual(['p2', 'p1']);
        expect(stack.topRef).toBe('designs:new');
    });

    it('expands the remembered kind when present, else the topmost expandable section; a formed parcel expands like any parcel', () => {
        const hits = { designs: [{ id: 'd' }], built: [{ id: 'b' }], formed: [{ id: 'f' }], parcels: [{ id: 'p' }] };
        expect(model.buildClickStack(hits).expanded).toBe('designs');
        expect(model.buildClickStack(hits, { remembered: 'parcels' }).expanded).toBe('parcels');
        expect(model.buildClickStack(hits, { remembered: 'permitted' }).expanded).toBe('designs');
        // A road's leftover piece: no design under the click, the formed piece is the ground to build on.
        expect(model.buildClickStack({ formed: [{ id: 'f' }], parcels: [{ id: 'p' }] }).expanded).toBe('formed');
        expect(model.buildClickStack({ formed: [{ id: 'f' }], parcels: [{ id: 'p' }] }, { remembered: 'parcels' }).expanded).toBe('parcels');
        const stack = model.buildClickStack(hits);
        expect(model.expand(stack, 'formed').expanded).toBe('formed');
        expect(model.expand(stack, 'built').expanded).toBe('built');
    });

    it('puts the point\'s own hits before what only stands on its parcel, and opens and closes on the point', () => {
        const hits = {
            designs: [{ id: 'newest', createdAt: 3, onParcel: true }, { id: 'older', createdAt: 1, onParcel: true }],
            built: [{ id: 'shed', onParcel: true }, { id: 'house' }],
            parcels: [{ id: 'p' }]
        };
        const stack = model.buildClickStack(hits);
        expect(kinds(stack)).toEqual(['designs', 'built', 'parcels']);
        expect(stack.sections.map(section => section.atPoint)).toEqual([false, true, true]);
        expect(stack.sections[1].instances.map(item => item.id)).toEqual(['house', 'shed']);
        expect(stack.sections[1].multi).toBe(true);
        expect(stack.sections[0].instances.map(item => item.id)).toEqual(['newest', 'older']);
        // The building under the point opens and is the top; the parcel's proposals wait for their row.
        expect(stack.expanded).toBe('built');
        expect(stack.topRef).toBe('built:house');
        expect(model.buildClickStack(hits, { remembered: 'designs' }).expanded).toBe('built');
        expect(model.buildClickStack(hits, { remembered: 'parcels' }).expanded).toBe('parcels');
        // Open ground: the parcel opens; a second click on the same parcel closes.
        const ground = model.buildClickStack({ designs: [{ id: 'd', onParcel: true }], parcels: [{ id: 'p' }] });
        expect(ground.expanded).toBe('parcels');
        expect(model.clickAction(ground.topRef, model.buildClickStack({ designs: [{ id: 'd', onParcel: true }], parcels: [{ id: 'p' }] }))).toBe('retain');
        expect(model.selectInstance(ground, 'designs', 'd').topRef).toBe('parcels:p');
    });

    it('keeps a chosen instance, and the top reference follows it', () => {
        const hits = { designs: [{ id: 'a', createdAt: 2 }, { id: 'b', createdAt: 1 }] };
        const stack = model.selectInstance(model.buildClickStack(hits), 'designs', 'b');
        expect(model.selectedInstance(stack, 'designs').id).toBe('b');
        expect(stack.topRef).toBe('designs:b');
        expect(model.selectedInstance(model.buildClickStack(hits, { selected: { designs: 'b' } }), 'designs').id).toBe('b');
    });

    it('closes on the same topmost object or on empty ground, and switches to a different spot', () => {
        const here = model.buildClickStack({ built: [{ id: 'b1' }], parcels: [{ id: 'p' }] });
        const there = model.buildClickStack({ built: [{ id: 'b2' }], parcels: [{ id: 'p' }] });
        const empty = model.buildClickStack({});
        expect(model.clickAction(null, here)).toBe('open');
        expect(model.clickAction(here.topRef, here)).toBe('retain');
        expect(model.clickAction(here.topRef, there)).toBe('open');
        expect(model.clickAction(here.topRef, empty)).toBe('close');
        expect(model.clickAction(null, empty)).toBe('none');
    });
});
