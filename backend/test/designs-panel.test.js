import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../../frontend/js/proposals/list-ui.js', import.meta.url), 'utf8');
const functions = parse(source).program.body.filter(node => node.type === 'FunctionDeclaration');
const code = name => { const node = functions.find(node => node.id.name === name); return source.slice(node.start, node.end); };

describe('design library and saved plans tabs', () => {
    it('switches browse and saved-plan contents with one keyboard tab stop', () => {
        const nodes = Object.fromEntries(['designs-browse', 'designs-plans', 'designs-browse-tab', 'shareAppliedProposalsButton'].map(id => [id, { setAttribute: vi.fn() }]));
        const select = new Function('document', `${code('setDesignsPanelTab')}; return setDesignsPanelTab;`)({ getElementById: id => nodes[id] });
        select('plans');
        expect(nodes['designs-browse'].hidden).toBe(true);
        expect(nodes['designs-plans'].hidden).toBe(false);
        expect(nodes['designs-browse-tab'].tabIndex).toBe(-1);
        expect(nodes.shareAppliedProposalsButton.tabIndex).toBe(0);
        select('browse');
        expect(nodes['designs-browse'].hidden).toBe(false);
        expect(nodes['designs-plans'].hidden).toBe(true);
        expect(nodes['designs-browse-tab'].tabIndex).toBe(0);
    });

    function harness() {
        const MapShell = { isOpen: () => false, openSheet: vi.fn() };
        const mount = vi.fn(() => Promise.resolve('mounted'));
        const showPlans = vi.fn(() => 'shown');
        const open = new Function('window', 'mountProposalList', 'setDesignsPanelTab', `let _designsPanelRequest = 0; ${code('openDesignsTab')}; return openDesignsTab;`)({ MapShell, PlanDialog: { showPlans } }, mount, vi.fn());
        return { MapShell, mount, showPlans, open };
    }

    it('opening Designs resolves after its list mounts, including when its sheet was closed', async () => {
        const h = harness();
        expect(await h.open('browse')).toBe('mounted');
        expect(h.MapShell.openSheet).toHaveBeenCalledWith('proposals-sheet');
    });

    it('opens the saved-plan view without opening the retired applied-design share panel', () => {
        const h = harness();
        expect(h.open('plans')).toBe('shown');
        expect(h.showPlans).toHaveBeenCalledTimes(1);
        expect(h.mount).not.toHaveBeenCalled();
        expect(h.MapShell.openSheet).toHaveBeenCalledWith('proposals-sheet');
    });
});
