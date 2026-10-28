import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { filterRows, indexQuery } = require('../../frontend/js/lists-panel.js');
const NamedPlans = require('../../frontend/js/named-plans.js');
const PlanRecord = require('../../frontend/js/plan-record.js');
const Cid = require('../../frontend/js/cid.js');
describe('shared lists', () => {
    it('registers the agreement tab and leaves no deletion command outside Lists', () => {
        const commands = require('../../frontend/js/ui/commands.js').listCommands();
        expect(commands.find(row => row.control === 'designs-agreements-tab')?.labelKey).toBe('sidebar.proposals.agreementsButton');
        expect(commands.find(row => row.id === 'proposals.list')?.labelKey).toBe('lists.title');
        expect(commands.some(row => row.id === 'proposals.clearLocal')).toBe(false);
    });
    const rows = [
        { title: 'Zebra', author: 'Team', published: false, createdAt: '2026-10-01' },
        { title: 'Alpha', author: 'Council', published: true, createdAt: '2026-10-02' }
    ];
    it('combines search and publication filters without mutating records', () => {
        expect(filterRows(rows, { search: ' council ', publication: 'published' })).toEqual([rows[1]]);
        expect(filterRows(rows, { search: 'alpha', publication: 'draft' })).toEqual([]);
        expect(filterRows(rows, {})).toEqual([rows[1], rows[0]]);
        expect(rows[0].title).toBe('Zebra');
    });
    it('asks the index for a city, or in explore for the designs in the visible area', () => {
        const explore = { explore: true, bbox: [90.39, 23.7, 90.42, 23.72] };
        expect(Object.fromEntries(indexQuery('designs', { city: 'zg' }))).toEqual({ limit: '1000', city: 'zg' });
        expect(Object.fromEntries(indexQuery('designs', { city: 'city', area: explore }))).toEqual({ limit: '1000', bbox: '90.39,23.7,90.42,23.72' });
        expect(Object.fromEntries(indexQuery('designs', { city: 'zg', area: { explore: false, bbox: null } }))).toEqual({ limit: '1000', city: 'zg' });
        // Plans and agreements page by offset and stay city-scoped.
        expect(Object.fromEntries(indexQuery('plans', { city: 'zg', area: explore, offset: 50 }))).toEqual({ limit: '50', city: 'zg', offset: '50' });
    });
    it('orders loaded records by their authored date', () => {
        expect(filterRows(rows, { sort: 'newest' }).map(row => row.title)).toEqual(['Alpha', 'Zebra']);
    });
    it('removes only the stored plan, retaining its agreement and member records', () => {
        const content = PlanRecord.create('Plan', [Cid.cidOfObject({ test: 'design' })], { city: 'london', at: '51.5,-0.1,17', mode: '2d', language: 'en' });
        const plan = { cid: Cid.cidOfObject(content), content };
        const storage = new Map([[`plan:${plan.cid}`, JSON.stringify(plan)], ['proposal:member', 'member'], ['agreement:one', 'agreement']]);
        const events = [];
        const api = NamedPlans.browser({ location: new URL('https://app.test/'), Cid, PlanRecord,
            CustomEvent: class { constructor(type) { this.type = type; } }, dispatchEvent: event => events.push(event.type),
            PersistentStorage: { getItem: key => storage.get(key), removeItem: key => storage.delete(key), forEach: fn => storage.forEach(fn) },
            AgreementStore: { list: () => [{ plan, designs: [{ proposalId: 'member' }] }] } });
        expect(api.list({ storedOnly: true })).toHaveLength(1);
        api.remove(plan.cid);
        expect(api.list({ storedOnly: true })).toHaveLength(0);
        expect(api.list()).toHaveLength(1); // inspection can still follow the agreement's exact subject
        expect([...storage.keys()]).toEqual(['proposal:member', 'agreement:one']);
        expect(events).toEqual(['planschange']);
    });
});
