// The click stack's ordering, counts, default instance, remembered section and close-or-switch rule.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const model = require('../../frontend/js/click-stack/click-stack-model.js');

it('navigates parcel → design → plan relationships without exposing agreements as spatial hits', () => {
    const parcel = { id: 'p1' };
    const formed = { id: 'piece', designId: 'd1', designLabel: 'Street', feature: { properties: { cadastreParcelIds: ['p1'] } } };
    const designs = [{ id: 'd1', label: 'Street', proposal: { cadastreParcelIds: ['p1'] }, createdAt: 1 }, { id: 'd2', label: 'Park', createdAt: 2 }];
    const plan = { id: 'pl1', content: { designs: [{ proposalId: 'd1' }, { proposalId: 'd2' }] } };
    const hits = { agreements: [{ id: 'a1' }], plans: [plan], designs, formed: [formed], parcels: [parcel] };
    const links = (kind, item) => model.contextFor(kind, item, hits).map(group => [group.position, group.kind, group.instances.map(item => item.id)]);
    expect(links('plans', plan)).toEqual([['below', 'designs', ['d1', 'd2']]]);
    expect(links('designs', designs[0])).toEqual([['above', 'plans', ['pl1']], ['below', 'formed', ['piece', 'p1']]]);
    // A design that both takes and forms parcels lists them as two tabs: what it forms, then what it takes.
    expect(model.contextFor('designs', designs[0], hits)[1].tabs.map(tab => [tab.relation, tab.kind, tab.instances.map(item => item.id)]))
        .toEqual([['formedParcels', 'formed', ['piece']], ['affectsParcels', 'parcels', ['p1']]]);
    expect(links('formed', formed)).toEqual([['above', 'designs', ['d1']], ['below', 'parcels', ['p1']]]);
    expect(links('parcels', parcel)).toEqual([['above', 'formed', ['piece']], ['above', 'designs', ['d1']]]);
    expect(model.contextFor('formed', formed, { ...hits, designs: [] })[0].instances).toEqual([{ id: 'd1', label: 'Street' }]);
});

const kinds = stack => stack.sections.map(section => section.kind);

it('places agreements for the selected exact plan above Plans without accepting unrelated spatial hits', () => {
    const stack = model.buildClickStack({ plans: [{ id: 'plan-a', cid: 'plan-a' }], agreements: [
        { id: 'a1', planCid: 'plan-a', onParcel: true }, { id: 'a2', plan: { cid: 'plan-a' }, onParcel: true }, { id: 'other', planCid: 'plan-b' }
    ] });
    expect(stack.sections.map(row => row.kind)).toEqual(['agreements', 'plans']);
    expect(stack.sections[0].count).toBe(2); expect(stack.expanded).toBe('plans');
});

it('shows one neighbouring level on either side without dropping the rest of the inventory', () => {
    const sections = ['agreements', 'plans', 'designs', 'formed', 'parcels'].map(kind => ({ kind }));
    expect(model.visibleSections({ sections, selectedKind: 'plans' }).map(row => row.kind)).toEqual(['agreements', 'plans', 'designs']);
    expect(model.visibleSections({ sections, selectedKind: 'designs' }).map(row => row.kind)).toEqual(['plans', 'designs', 'formed']);
    expect(model.visibleSections({ sections, selectedKind: 'agreements' }).map(row => row.kind)).toEqual(['agreements', 'plans']);
    expect(model.visibleSections({ sections, selectedKind: 'parcels' }).map(row => row.kind)).toEqual(['formed', 'parcels']);
    expect(sections).toHaveLength(5);
});

it('shows an observed building with its parcel instead of an authored-plan chain', () => {
    const sections = ['plans', 'designs', 'built', 'permitted', 'formed', 'parcels'].map(kind => ({ kind }));
    expect(model.visibleSections({ sections, selectedKind: 'built' }).map(row => row.kind)).toEqual(['built', 'parcels']);
    expect(sections).toHaveLength(6);
    const designs = [{ id: 'demolisher', label: 'Redevelop' }, { id: 'nearby', label: 'Nearby park' }];
    const hits = { designs, plans: [{ id: 'plan' }] };
    expect(model.contextFor('built', { id: 'house' }, hits)).toEqual([]);
    const links = model.visibleContextFor('built', { id: 'house', demolition: { proposalKey: 'demolisher' } }, hits);
    expect(links.map(group => [group.relation, group.instances.map(row => row.id)])).toEqual([['affectedBy', ['demolisher']]]);
});

it('shows the design that formed a parcel above the buildings and massing standing on it', () => {
    const formed = { id: 'piece', designId: 'layout', feature: { properties: { cadastreParcelIds: ['p1'] } } };
    const design = { id: 'layout', label: 'Layout', proposal: { cadastreParcelIds: ['p1'] } };
    const hits = { plans: [{ id: 'plan' }], designs: [design], built: [{ id: 'house' }], permitted: [{ id: 'm1' }], formed: [formed], parcels: [{ id: 'p1' }] };
    const shown = (input, kind) => model.visibleSections({ ...model.buildClickStack(input), selectedKind: kind }).map(section => section.kind);
    // Built and Permitted are not the authored chain: the design above them stays one step away.
    expect(shown(hits, 'formed')).toEqual(['designs', 'built', 'permitted', 'formed', 'parcels']);
    expect(shown({ ...hits, permitted: [] }, 'formed')).toEqual(['designs', 'built', 'formed', 'parcels']);
    expect(shown({ ...hits, formed: [] }, 'parcels')).toEqual(['designs', 'built', 'permitted', 'parcels']);
    // An authored level above keeps the one-step rule.
    expect(shown({ ...hits, built: [], permitted: [] }, 'formed')).toEqual(['designs', 'formed', 'parcels']);
    expect(shown(hits, 'designs')).toEqual(['plans', 'designs', 'built']);
    // The design row is then on screen, so its single "Created by" strip would only repeat it.
    expect(model.visibleContextFor('formed', formed, hits).filter(group => group.relation === 'createdBy')).toEqual([]);
});

describe('click stack model', () => {
    it('orders plans, designs, built, permitted, formed parcel, cadastral parcels, showing only what is there', () => {
        expect(kinds(model.buildClickStack({ built: [{ id: 'b1' }], parcels: [{ id: 'p1' }] }))).toEqual(['built', 'parcels']);
        expect(kinds(model.buildClickStack({ parcels: [{ id: 'p1' }], permitted: [{ id: 'm1' }], built: [{ id: 'b1' }], formed: [{ id: 'f1' }] })))
            .toEqual(['built', 'permitted', 'formed', 'parcels']);
        expect(kinds(model.buildClickStack({ parcels: [{ id: 'p1' }], designs: [{ id: 'd1' }], built: [{ id: 'b1' }], permitted: [{ id: 'm1' }], plans: [{ id: 'pl1' }], agreements: [{ id: 'a1' }] })))
            .toEqual(['plans', 'designs', 'built', 'permitted', 'parcels']);
        expect(kinds(model.buildClickStack({ agreements: [{ id: 'a1' }], plans: [{ id: 'pl1' }], designs: [{ id: 'd1' }] })))
            .toEqual(['plans', 'designs']);
        expect(model.buildClickStack({}).sections).toEqual([]);
        expect(kinds(model.buildClickStack({ ground: [{ id: 'here' }] }))).toEqual(['ground']);
        expect(model.buildClickStack({ ground: [{ id: 'here' }] }).expanded).toBe('ground');
    });

    it('relates plans to exact design identities and labels missing members', () => {
        const d1 = { id: 'local-1', cid: 'bafy-design-one', label: 'Road' };
        const d2 = { id: 'local-2', serverId: 'server-2', label: 'Park' };
        const plan = { id: 'pl', content: { designCids: ['bafy-design-one', 'bafy-missing'] } };
        const hits = { plans: [plan], agreements: [{ id: 'ag' }], designs: [d1, d2] };
        expect(model.contextFor('plans', plan, hits).map(group => [group.relation, group.instances.map(item => item.id)]))
            .toEqual([['includedDesigns', ['local-1', 'bafy-missing']]]);
        expect(model.contextFor('designs', d1, hits).map(group => [group.relation, group.instances.map(item => item.id)]))
            .toEqual([['memberPlans', ['pl']]]);
        expect(model.contextFor('designs', d2, hits)).toEqual([]);
    });

    it('keeps published CID membership separate from an edited local design with the same local id', () => {
        const edited = { id: 'local-1', cid: 'bafy-new-version', label: 'Edited road' };
        const plan = { id: 'pl-old', designCids: ['bafy-old-version'] };
        const hits = { plans: [plan], agreements: [{ id: 'ag-old' }], designs: [edited] };
        const planMember = model.contextFor('plans', plan, hits)[0].instances[0];
        expect(planMember).toMatchObject({ id: 'bafy-old-version', serverId: 'bafy-old-version' });
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

    it('keeps the design-to-plan navigation visible even for a single plan', () => {
        const design = { id: 'd1', label: 'Road' };
        const plan = { id: 'pl1', content: { designs: [{ proposalId: 'd1' }] } };
        const hits = { designs: [design], plans: [plan] };
        expect(model.contextFor('designs', design, hits).map(group => group.kind)).toEqual(['plans']);
        expect(model.visibleContextFor('designs', design, hits)[0].instances).toEqual([plan]);
        expect(model.visibleContextFor('designs', design, { designs: [design], plans: [{ id: 'pl2' }, plan] }))
            .toHaveLength(1);
        // The relationship still navigates when its target isn't represented in the current stack.
        expect(model.visibleContextFor('plans', plan, { designs: [] })[0].instances)
            .toEqual([{ id: 'd1', label: 'd1' }]);
    });

    it('counts instances, selects the newest design, and drops duplicates', () => {
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

it('frames an object opened from a list or link only when it is out of view or too small to see', () => {
    const view = { left: 40, top: 40, right: 600, bottom: 700 };
    expect(model.framingNeeded({ left: 100, top: 100, right: 200, bottom: 180 }, view)).toBe(false);
    expect(model.framingNeeded({ left: 560, top: 100, right: 700, bottom: 180 }, view)).toBe(true);
    expect(model.framingNeeded({ left: -900, top: -400, right: -800, bottom: -300 }, view)).toBe(true);
    expect(model.framingNeeded({ left: 300, top: 300, right: 305, bottom: 304 }, view)).toBe(true);
    expect(model.framingNeeded({ left: 300, top: 300, right: 305, bottom: 304 }, view, 4)).toBe(false);
    expect(model.framingNeeded({ left: NaN, top: 0, right: 1, bottom: 1 }, view)).toBe(false);
    expect(model.framingNeeded(null, view)).toBe(false);
});
