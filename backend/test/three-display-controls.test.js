// Guards the compact Built/Planned selector contract so the fourth Built state cannot reintroduce
// uneven segmented widths or label truncation in abstract 3D.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const PlanningScene = require('../../frontend/js/planning/scene.js');
const planningViewsSource = readFileSync(new URL('../../frontend/js/planning/views.js', import.meta.url), 'utf8');
const mapCssSource = readFileSync(new URL('../../frontend/css/map.css', import.meta.url), 'utf8');

function controlDeclaration() {
    const ast = parse(planningViewsSource, { sourceType: 'script' });
    const found = [];
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'FunctionDeclaration' && node.id?.name === 'control') found.push(node);
        for (const [key, value] of Object.entries(node)) {
            if (key === 'loc' || key === 'start' || key === 'end') continue;
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    };
    visit(ast);
    expect(found).toHaveLength(1);
    return planningViewsSource.slice(found[0].start, found[0].end);
}

describe('abstract 3D display controls', () => {
    it('builds labeled planning selectors from shared choices and forwards changes to the store', () => {
        expect(planningViewsSource).toContain("const details = { existing: 'existingScope', permitted: 'permittedMap', proposed: 'proposedForm' };");
        expect(planningViewsSource).toContain('for (const role of core.roles)');
        expect(planningViewsSource).toContain('row.append(name, control(role), control(details[role]));');
        expect(planningViewsSource).toContain("select.setAttribute('aria-label', t('displayLabel', { role: t(role) }));");
        expect(planningViewsSource).toContain(".setAttribute('aria-label', t(key));");

        const controls = [];
        const store = PlanningScene.createStore();
        const context = vm.createContext({
            core: PlanningScene,
            store,
            t: value => `label:${value}`,
            Option: function (text, value) { return { text, value }; },
            element(tag, className) {
                const node = { tag, className, dataset: {}, options: [], listeners: {},
                    add(option) { this.options.push(option); },
                    addEventListener(type, listener) { this.listeners[type] = listener; },
                    setAttribute(name, value) { this[name] = value; } };
                controls.push(node);
                return node;
            }
        });
        vm.runInContext(`${controlDeclaration()}\nthis.makeControl = control;`, context);
        const existing = context.makeControl('existing');
        expect(existing).toMatchObject({ tag: 'select', className: 'planning-layer-select', dataset: { planningSetting: 'existing' } });
        expect(existing.options).toEqual(PlanningScene.choices.existing.map(value => ({ text: `label:${value}`, value })));
        existing.value = 'off';
        existing.listeners.change();
        expect(store.get().existing).toBe('off');

        const representation = context.makeControl('proposedForm');
        expect(representation.dataset.planningSetting).toBe('proposedForm');
        expect(representation.options).toEqual(PlanningScene.choices.proposedForm.map(value => ({ text: `label:${value}`, value })));
    });

    it('keeps both selectors at one readable desktop width and lets them fill narrow screens', () => {
        expect(mapCssSource).toMatch(/#model-layer-controls \.three-mode-display-select\s*\{[\s\S]*?width: 168px;/);
        expect(mapCssSource).toMatch(/@media \(max-width: 480px\)[\s\S]*?#model-layer-controls \.three-mode-display-select\s*\{[\s\S]*?width: auto;/);
    });
});
