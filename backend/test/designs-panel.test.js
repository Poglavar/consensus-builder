import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../../frontend/js/proposals/list-ui.js', import.meta.url), 'utf8');
const functions = parse(source).program.body.filter(node => node.type === 'FunctionDeclaration');
const code = name => { const node = functions.find(node => node.id.name === name); return source.slice(node.start, node.end); };

describe('combined Designs panel', () => {
    it('switches visible contents and the single keyboard tab stop together', () => {
        const nodes = Object.fromEntries(['designs-browse', 'designs-share', 'designs-browse-tab', 'shareAppliedProposalsButton'].map(id => [id, { setAttribute: vi.fn() }]));
        const select = new Function('document', `${code('setDesignsPanelTab')}; return setDesignsPanelTab;`)({ getElementById: id => nodes[id] });
        select('share');
        expect(nodes['designs-browse'].hidden).toBe(true);
        expect(nodes['designs-share'].hidden).toBe(false);
        expect(nodes['designs-browse-tab'].tabIndex).toBe(-1);
        expect(nodes.shareAppliedProposalsButton.tabIndex).toBe(0);
        select('browse');
        expect(nodes['designs-browse'].hidden).toBe(false);
        expect(nodes['designs-share'].hidden).toBe(true);
        expect(nodes['designs-browse-tab'].tabIndex).toBe(0);
    });

    function harness() {
        const MapShell = { isOpen: () => false, openSheet: vi.fn() };
        const mount = vi.fn(() => Promise.resolve('mounted'));
        const share = vi.fn();
        const closeShare = vi.fn();
        const open = new Function('window', 'mountProposalList', 'shareAppliedProposals', 'closeSharePlanPanel', 'setDesignsPanelTab', `let _designsPanelRequest = 0; ${code('openDesignsTab')}; return openDesignsTab;`)({ MapShell }, mount, share, closeShare, vi.fn());
        return { MapShell, mount, share, closeShare, open };
    }

    it('opening Designs resolves after its list mounts, including when its sheet was closed', async () => {
        const h = harness();
        expect(await h.open('browse')).toBe('mounted');
        expect(h.MapShell.openSheet).toHaveBeenCalledWith('proposals-sheet');
        expect(h.closeShare).toHaveBeenCalledWith({ fromPanel: true });
    });

    it('returning to Designs invalidates a deferred Share open', () => {
        const h = harness();
        h.open('share');
        const request = h.share.mock.calls[0][0];
        expect(request.isCurrent()).toBe(true);
        h.open('browse');
        expect(request.isCurrent()).toBe(false);
    });
});
