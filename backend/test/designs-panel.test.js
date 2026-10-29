import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../../frontend/js/proposals/list-ui.js', import.meta.url), 'utf8');
const functions = parse(source).program.body.filter(node => node.type === 'FunctionDeclaration');
const code = name => { const node = functions.find(node => node.id.name === name); return source.slice(node.start, node.end); };

describe('design library and saved plans tabs', () => {
    // Tab switching and its keyboard tab stops moved to ListsPanel.select (lists-panel.js) in
    // 01268caee "Unify design plan and agreement lists"; list-ui.js only opens the sheet and delegates.
    it('selects a tab through the shared Lists panel', async () => {
        const select = vi.fn(async tab => `selected ${tab}`);
        const setTab = new Function('window', `${code('setDesignsPanelTab')}; return setDesignsPanelTab;`)({ ListsPanel: { select } });
        expect(await setTab('plans')).toBe('selected plans');
        expect(select).toHaveBeenCalledExactlyOnceWith('plans');
    });

    function harness({ open = false } = {}) {
        const MapShell = { isOpen: vi.fn(() => open), openSheet: vi.fn() };
        let mounted;
        const select = vi.fn(tab => new Promise(resolve => { mounted = () => resolve(`mounted ${tab}`); }));
        const openTab = new Function('window', `${code('openDesignsTab')}; return openDesignsTab;`)({ MapShell, ListsPanel: { select } });
        return { MapShell, select, open: openTab, mount: () => mounted() };
    }

    it('opening Designs resolves after its list mounts, including when its sheet was closed', async () => {
        const h = harness();
        let settled = false;
        const opened = h.open('designs').then(value => { settled = true; return value; });
        expect(h.MapShell.openSheet).toHaveBeenCalledWith('proposals-sheet');
        expect(h.select).toHaveBeenCalledExactlyOnceWith('designs');
        await Promise.resolve();
        expect(settled).toBe(false);
        h.mount();
        expect(await opened).toBe('mounted designs');
    });

    it('does not reopen a sheet that is already open', async () => {
        const h = harness({ open: true });
        const opened = h.open('plans');
        h.mount();
        expect(await opened).toBe('mounted plans');
        expect(h.MapShell.openSheet).not.toHaveBeenCalled();
    });
});
