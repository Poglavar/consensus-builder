// Shared relationship labels, safe navigation buttons and native instance choices.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { makeDocument } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const relations = require('../../frontend/js/click-stack/click-stack-relations.js');

describe('click stack relationship rendering', () => {
    it('renders translated relation labels and safe related buttons with their routing data', () => {
        const doc = makeDocument();
        const translations = new Map();
        const win = { i18n: {
            registerTranslations: vi.fn((language, entries) => {
                if (language === 'hr') Object.entries(entries).forEach(([key, value]) => translations.set(key, value));
            }),
            t: key => translations.get(key) || key
        } };

        const group = relations.renderGroup({
            relation: 'memberPlans', kind: 'plans', count: 1,
            instances: [{ id: 'p-7', label: '<img src=x onerror=alert(1)>' }]
        }, doc, win);

        const label = group.querySelector('.click-stack__relation-label');
        const button = group.querySelector('.click-stack__chip');
        expect(label.textContent).toBe('Član planova:');
        expect(group.getAttribute('aria-label')).toBe('Član planova:');
        expect(group.querySelectorAll('img')).toHaveLength(0);
        expect(button.textContent).toBe('<img src=x onerror=alert(1)>');
        expect(button.getAttribute('data-action')).toBe('related');
        expect(button.getAttribute('data-kind')).toBe('plans');
        expect(button.getAttribute('data-id')).toBe('p-7');
    });

    it('renders a labelled selector for all instances, selects the current id, and omits it for single items', () => {
        const doc = makeDocument();
        const win = { i18n: { registerTranslations: vi.fn(), t: key => key === 'clickStackRelations.chooseInstance' ? 'Choose item' : key } };
        const wrapper = relations.renderSelector({
            kind: 'designs', multi: true, selectedIndex: 1,
            instances: [{ id: 'd-1', label: 'First' }, { id: 'd-2', label: 'Second' }]
        }, doc, win);

        const select = wrapper.querySelector('select.click-stack__selector');
        expect(wrapper.tagName).toBe('LABEL');
        expect(wrapper.textContent).toContain('Choose item');
        expect(select.getAttribute('data-action')).toBe('instance');
        expect(select.getAttribute('data-kind')).toBe('designs');
        expect(select.children.map(option => option.value)).toEqual(['d-1', 'd-2']);
        expect(select.children.map(option => option.textContent)).toEqual(['First', 'Second']);
        expect(select.selectedIndex).toBe(1);
        expect(relations.renderSelector({ multi: false, instances: [{ id: 'one' }] }, doc, win)).toBeNull();
    });
});
