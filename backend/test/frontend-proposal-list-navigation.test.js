import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const listUiSource = fs.readFileSync(path.join(FRONTEND, 'js/proposals/list-ui.js'), 'utf8');

function loadListUi(overrides = {}) {
    const calls = [];
    let isThreeD = overrides.isThreeD === true;
    const defaultDocument = {
        body: { classList: { contains: name => name === 'three-mode-active' && isThreeD } },
        addEventListener: vi.fn(),
        querySelector: selector => selector === '.proposal-list-modal' ? overrides.modal || null : null
    };
    const document = overrides.document || defaultDocument;
    const proposal = { proposalId: 'proposal-17' };
    const window = {
        currentlyHighlightedProposalId: null,
        requestMapMode: async mode => { calls.push(['mode', mode]); if (mode === '2d') isThreeD = false; },
        ...overrides.window
    };
    const context = {
        console,
        document,
        window,
        proposalListState: { source: 'local' },
        getProposalByIdOrHash: vi.fn(() => proposal),
        getProposalKey: vi.fn(() => 'proposal-17'),
        previewProposalOnMap: vi.fn((id, options) => calls.push(['preview', id, options])),
        openProposalFromList: vi.fn((id, options) => calls.push(['details', id, options])),
        selectAndHighlightProposal: vi.fn(),
        ...overrides.context
    };
    vm.createContext(context);
    vm.runInContext(listUiSource, context, { filename: 'frontend/js/proposals/list-ui.js' });
    return { context, calls, proposal };
}

function clickEvent(currentTarget, target = currentTarget) {
    return {
        currentTarget,
        target,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn()
    };
}

describe('proposal list navigation', () => {
    it('replaces the temporary loading shell when mounting the proposal list', () => {
        const spinner = { className: 'proposal-list-loading' };
        const modal = { className: '' };
        const host = {
            children: [spinner],
            get firstElementChild() { return host.children[0] || null; },
            ownerDocument: { createElement: () => modal },
            querySelector: selector => selector === '.proposal-list-modal'
                ? host.children.find(child => child.className === 'proposal-list-modal') || null
                : null,
            replaceChildren: (...children) => { host.children = children; }
        };
        const { context } = loadListUi();

        const mounted = context.ensureProposalListHostModal(host);

        expect(mounted).toBe(modal);
        expect(host.children).toEqual([modal]);
        expect(host.children.some(child => child.className === 'proposal-list-loading')).toBe(false);
    });

    it('removes a leftover loading shell beside an already-mounted proposal list', () => {
        const spinner = { className: 'proposal-list-loading' };
        const modal = { className: 'proposal-list-modal' };
        const host = {
            children: [spinner, modal],
            get firstElementChild() { return host.children[0] || null; },
            ownerDocument: { createElement: vi.fn() },
            querySelector: () => modal,
            replaceChildren: (...children) => { host.children = children; }
        };
        const { context } = loadListUi();

        expect(context.ensureProposalListHostModal(host)).toBe(modal);
        expect(host.children).toEqual([modal]);
    });

    it('does not render after the proposals sheet closes while mounting is yielded', async () => {
        let resolveYield;
        let isOpen = true;
        const host = {
            innerHTML: '',
            setAttribute: vi.fn(),
            removeAttribute: vi.fn(),
            querySelector: vi.fn(() => null)
        };
        const document = {
            body: { classList: { contains: () => false } },
            addEventListener: vi.fn(),
            querySelector: vi.fn(() => null),
            getElementById: vi.fn(() => host)
        };
        const render = vi.fn();
        const { context } = loadListUi({
            document,
            window: {
                MapShell: { isOpen: () => isOpen },
                yieldToBrowser: () => new Promise(resolve => { resolveYield = resolve; })
            },
            context: {
                markProposalCountAreaOpened: vi.fn(),
                resetParcelSelectionForProposalListInteraction: vi.fn(),
                clearProposalInfoHoverOverlay: vi.fn(),
                shouldAutofocusProposalListSearch: vi.fn(() => false),
                renderProposalListModal: render
            }
        });

        const pending = context.mountProposalList();
        await Promise.resolve();
        isOpen = false;
        resolveYield();

        await expect(pending).resolves.toBe(false);
        expect(render).not.toHaveBeenCalled();
        expect(host.removeAttribute).toHaveBeenCalledWith('aria-busy');
    });

    it('uses a row click only to preview and frame a proposal', async () => {
        const modal = { querySelectorAll: () => [] };
        const row = {
            getAttribute: name => name === 'data-proposal-id' ? 'proposal-17' : null,
            classList: { add: vi.fn() }
        };
        const { context, calls } = loadListUi({ modal });

        await context.handleProposalListItemClick(clickEvent(row));

        expect(context.previewProposalOnMap).toHaveBeenCalledWith('proposal-17', { center: true, blink: true });
        expect(context.selectAndHighlightProposal).not.toHaveBeenCalled();
        expect(calls).toEqual([['preview', 'proposal-17', { center: true, blink: true }]]);
    });

    it('switches from 3D to 2D before opening explicit proposal details', async () => {
        const { context, calls } = loadListUi({ isThreeD: true });
        const button = { getAttribute: name => name === 'data-proposal-details' ? 'proposal-17' : null };

        await context.handleProposalListDetailsClick(clickEvent(button));

        expect(calls.map(([kind]) => kind)).toEqual(['mode', 'details']);
        expect(calls[0]).toEqual(['mode', '2d']);
        expect(calls[1][1]).toBe('proposal-17');
        expect(calls[1][2]).toMatchObject({ centerOnProposal: false, closeSheets: true });
        expect(context.openProposalFromList).toHaveBeenCalledTimes(1);
    });
});
