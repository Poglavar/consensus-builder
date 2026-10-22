// The click stack's ordering, counts, default instance, remembered section and close-or-switch rule.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const model = require('../../frontend/js/click-stack/click-stack-model.js');

const kinds = stack => stack.sections.map(section => section.kind);

describe('click stack model', () => {
    it('orders agreements, designs, built, permitted, formed parcel, cadastral parcels, showing only what is there', () => {
        expect(kinds(model.buildClickStack({ built: [{ id: 'b1' }], parcels: [{ id: 'p1' }] }))).toEqual(['built', 'parcels']);
        expect(kinds(model.buildClickStack({ parcels: [{ id: 'p1' }], permitted: [{ id: 'm1' }], built: [{ id: 'b1' }], formed: [{ id: 'f1' }] })))
            .toEqual(['built', 'permitted', 'formed', 'parcels']);
        expect(kinds(model.buildClickStack({ parcels: [{ id: 'p1' }], designs: [{ id: 'd1' }], built: [{ id: 'b1' }], permitted: [{ id: 'm1' }], agreements: [{ id: 'a1' }] })))
            .toEqual(['agreements', 'designs', 'built', 'permitted', 'parcels']);
        expect(model.buildClickStack({}).sections).toEqual([]);
        expect(kinds(model.buildClickStack({ ground: [{ id: 'here' }] }))).toEqual(['ground']);
        expect(model.buildClickStack({ ground: [{ id: 'here' }] }).expanded).toBe('ground');
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
        expect(model.clickAction(here.topRef, here)).toBe('close');
        expect(model.clickAction(here.topRef, there)).toBe('open');
        expect(model.clickAction(here.topRef, empty)).toBe('close');
        expect(model.clickAction(null, empty)).toBe('none');
    });
});
