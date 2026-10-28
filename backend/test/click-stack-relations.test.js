// Shared relationship labels, safe navigation buttons and native instance choices.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { dictionary, testI18n } from './helpers/i18n.js';
import { makeDocument } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const relations = require('../../frontend/js/click-stack/click-stack-relations.js');
const goals = require('../../frontend/js/proposals/design-goals.js');

describe('click stack relationship rendering', () => {
    it('renders translated relation labels and safe related buttons with their routing data', () => {
        const doc = makeDocument();
        const win = { i18n: testI18n('hr') };

        const group = relations.renderGroup({
            relation: 'memberPlans', kind: 'plans', count: 1,
            instances: [{ id: 'p-7', label: '<img src=x onerror=alert(1)>' }]
        }, doc, win);

        const label = group.querySelector('.click-stack__relation-label');
        const button = group.querySelector('.click-stack__chip');
        expect(label.textContent).toBe('Uključeno u planove:');
        expect(group.getAttribute('aria-label')).toBe('Uključeno u planove:');
        expect(group.querySelectorAll('img')).toHaveLength(0);
        expect(button.textContent).toBe('<img src=x onerror=alert(1)>');
        expect(button.getAttribute('data-action')).toBe('related');
        expect(button.getAttribute('data-kind')).toBe('plans');
        expect(button.getAttribute('data-id')).toBe('p-7');
    });

    it('renders a labelled selector for all instances, selects the current id, and omits it for single items', () => {
        const doc = makeDocument();
        const win = { i18n: testI18n(), ProposalDesignGoals: goals };
        const wrapper = relations.renderSelector({
            kind: 'designs', multi: true, selectedIndex: 1,
            instances: [{ id: 'd-1', label: 'First', goal: 'park' }, { id: 'd-2', label: 'Second', goal: 'urban-rule' }]
        }, doc, win);

        const select = wrapper.querySelector('select.click-stack__selector');
        expect(wrapper.tagName).toBe('LABEL');
        expect(wrapper.querySelector('.click-stack__selector-label').textContent).toBe('Location you clicked has multiple designs. Select which to inspect:');
        expect(wrapper.querySelector('small')).toBeNull();
        expect(select.getAttribute('aria-describedby')).toBeNull();
        expect(select.getAttribute('data-action')).toBe('instance');
        expect(select.getAttribute('data-kind')).toBe('designs');
        expect(select.children.map(option => option.value)).toEqual(['d-1', 'd-2']);
        expect(select.children.map(option => option.textContent)).toEqual(['Park · First', 'Urban rule · Second']);
        expect(select.selectedIndex).toBe(1);
        expect(wrapper.querySelector('.click-stack__selector-value').textContent).toBe('Second');
        expect(wrapper.querySelector('.click-stack__selector-value').getAttribute('aria-hidden')).toBe('true');
        select.value = 'd-1';
        select.dispatchEvent({ type: 'change', target: select });
        expect(wrapper.querySelector('.click-stack__selector-value').textContent).toBe('First');
        expect(relations.renderSelector({ multi: false, instances: [{ id: 'one' }] }, doc, win)).toBeNull();
    });

    it('adds exact plan membership to menu labels without changing the closed design title', () => {
        const win = { i18n: testI18n(), ProposalDesignGoals: goals, DesignSync: { publishedCid: proposal => proposal.published?.cid },
            NamedPlans: { current: { content: { title: 'Riverside plan', designCids: ['cid-a', 'cid-b'] } } } };
        const section = { kind: 'designs', multi: true, selectedIndex: 0, instances: [
            { id: 'a', label: 'Tower A', proposal: { goal: 'single', published: { cid: 'cid-a' } } },
            { id: 'b', label: 'Garden', proposal: { goal: 'park', published: { cid: 'cid-b' } } }
        ] };
        const wrapper = relations.renderSelector(section, makeDocument(), win, [
            { label: 'Other plan', membershipDesignCid: 'cid-a' },
            { label: 'Unrelated plan', membershipDesignCid: 'cid-other' },
            { label: 'Loading…', membershipPlaceholder: true, membershipDesignCid: 'cid-a' }
        ]);
        const select = wrapper.querySelector('select');
        expect(select.children[0].textContent).toBe(`${goals.get('single').label} · Tower A · Included in plans: Other plan, Riverside plan`);
        expect(select.children[1].textContent).toBe('Park · Garden · Included in plans: Riverside plan');
        expect(wrapper.querySelector('.click-stack__selector-value').textContent).toBe('Tower A');
        relations.updateSelector(section, wrapper, win, [{ label: 'New plan', membershipDesignCid: 'cid-a' }]);
        expect(wrapper.querySelector('select')).toBe(select);
        expect(select.children[0].textContent).toContain('New plan, Riverside plan');
        expect(select.children[0].textContent).not.toContain('Other plan');
        expect(wrapper.querySelector('.click-stack__selector-value').textContent).toBe('Tower A');
    });

    it.each(goals.keys)('keeps the authored %s type independent of a misleading design title', goal => {
        const type = relations.designType({ proposal: { goal, title: 'Park' } }, { ProposalDesignGoals: goals });
        expect(type).toMatchObject({ goal, label: goals.get(goal).label });
        expect(type.icon).toBeTruthy();
        expect(['neutral', 'success', 'warning', 'info', 'primary']).toContain(type.tone);
        expect(relations.designType({ title: 'Park', type: 'park' }, { ProposalDesignGoals: goals })).toBeNull();
    });

    it('uses the localized type and existing goal icon safely, including when the title is identical', () => {
        const doc = makeDocument();
        const win = { getProposalDisplayTypeLabel: () => '<Park>', getProposalGoalBadge: () => ({ text: '🌳' }) };
        const pill = relations.renderDesignType({ goal: 'park', title: '<Park>' }, doc, win);
        expect(pill.classList.contains('cb-badge--success')).toBe(true);
        expect(pill.dataset.designGoal).toBe('park');
        expect(pill.children[0].textContent).toBe('🌳');
        expect(pill.children[0].getAttribute('aria-hidden')).toBe('true');
        expect(pill.children[1].textContent).toBe('<Park>');
        expect(pill.querySelector('park')).toBeNull();
        const road = { goal: 'road-track' };
        expect(relations.designType(road, { ...win, isTrackProposal: () => true }).icon).toBe('🛤️');
        expect(relations.designType(road, { ...win, isTrackProposal: () => false }).icon).toBe('🛣️');
    });

    it.each(['en', 'hr', 'sr', 'es'])('names and explains the design selector in %s', language => {
        const win = { i18n: testI18n(language) };
        const selector = relations.renderSelector({ kind: 'designs', multi: true, instances: [] }, makeDocument(), win);
        expect(selector.querySelector('.click-stack__selector-label').textContent).toBe(dictionary(language).clickStackRelations.chooseDesign);
        expect(selector.querySelector('.click-stack__selector-label').textContent.length).toBeGreaterThan(40);
        expect(selector.querySelector('small')).toBeNull();
    });
});

describe('design card actions', () => {
    const track = (button, work) => work();
    it('heads the card with Add to plan for a design held on this device', async () => {
        const addDesign = vi.fn(async () => null);
        const win = { i18n: testI18n(), BusyControl: { track }, PlanDialog: { addDesign },
            proposalStorage: { getProposal: id => (id === 'local-1' ? { proposalId: id } : null) } };
        const actions = relations.renderDesignActions({ id: 'local-1' }, makeDocument(), win);
        const button = actions.querySelector('[data-design-action="add-to-plan"]');
        expect(button.textContent).toBe(dictionary('en').planDialog.addToPlan);
        button.click();
        await vi.waitFor(() => expect(addDesign).toHaveBeenCalledWith('local-1'));
    });
    it('imports a published design this browser lacks before adding it', async () => {
        const addDesign = vi.fn(async () => null);
        const win = { i18n: testI18n(), BusyControl: { track }, PlanDialog: { addDesign },
            proposalStorage: { getProposal: () => null },
            DesignSync: { fetchDesign: vi.fn(async id => ({ id })), importDesign: vi.fn(async () => ({ proposalId: 'imported-9' })) },
            getProposalKey: proposal => proposal.proposalId };
        relations.renderDesignActions({ id: 'srv', serverId: 'bafy-x' }, makeDocument(), win).querySelector('button').click();
        await vi.waitFor(() => expect(addDesign).toHaveBeenCalledWith('imported-9'));
        expect(win.DesignSync.fetchDesign).toHaveBeenCalledWith('bafy-x');
    });
});
