import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const listUiSource = fs.readFileSync(path.join(FRONTEND, 'js/proposals/list-ui.js'), 'utf8');
const coreSource = fs.readFileSync(path.join(FRONTEND, 'js/proposals/core.js'), 'utf8');

// One top-level function of proposals/core.js (a classic script), on its own.
function coreFunction(name) {
    const node = parse(coreSource, { sourceType: 'script' }).program.body
        .find(item => item.type === 'FunctionDeclaration' && item.id.name === name);
    if (!node) throw new Error(`${name} not found in proposals/core.js`);
    return new Function(`${coreSource.slice(node.start, node.end)}\nreturn ${name};`)();
}

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
    it('looks up the local copy of a server row by the design CID the row lists', async () => {
        const cid = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
        const local = { proposalId: `design-${cid}` };
        const findLocal = vi.fn(() => local);
        const DesignSync = { fetchDesign: vi.fn(), importDesign: vi.fn() };
        const row = {
            getAttribute: name => ({ 'data-proposal-id': cid, 'data-cid': cid })[name] || null,
            classList: { add: vi.fn() },
            querySelectorAll: () => []
        };
        const { context } = loadListUi({
            modal: { querySelectorAll: () => [] },
            window: { DesignSync },
            context: {
                proposalListState: { source: 'server' },
                findLocalCopyOfServerProposal: findLocal,
                getProposalKey: () => local.proposalId
            }
        });

        await context.handleProposalListItemClick(clickEvent(row));
        expect(findLocal).toHaveBeenCalledWith({ cid });
        expect(context.previewProposalOnMap).toHaveBeenCalledWith(local.proposalId, { center: true, blink: true });

        findLocal.mockClear();
        context.openListedProposal = vi.fn();
        const details = {
            getAttribute: name => name === 'data-proposal-details' ? cid : null,
            closest: selector => selector === '.proposal-list-item' ? row : null
        };
        await context.handleProposalListDetailsClick(clickEvent(details));
        expect(findLocal).toHaveBeenCalledWith({ cid });
        expect(context.openListedProposal).toHaveBeenCalledWith(local, cid, 'details');
        // A copy held here opens as it is; nothing is fetched.
        expect(DesignSync.fetchDesign).not.toHaveBeenCalled();
        expect(DesignSync.importDesign).not.toHaveBeenCalled();
    });

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

    it('keeps 3D while opening and centering explicit design details', async () => {
        const { context, calls } = loadListUi({ isThreeD: true });
        const button = { getAttribute: name => name === 'data-proposal-details' ? 'proposal-17' : null };

        await context.handleProposalListDetailsClick(clickEvent(button));

        expect(calls.map(([kind]) => kind)).toEqual(['details']);
        expect(calls[0][1]).toBe('proposal-17');
        expect(calls[0][2]).toMatchObject({ centerOnProposal: true, closeSheets: true, presentation: 'details' });
        expect(context.openProposalFromList).toHaveBeenCalledTimes(1);
    });

    // A phone's list fills the screen, so a preview would land behind it: the tap goes to the
    // proposal on the map with its compact card instead, centred, and the list closes.
    it('on a phone, where the list covers the map, opens the tapped proposal compact and centred', async () => {
        const row = {
            getAttribute: name => name === 'data-proposal-id' ? 'proposal-17' : null,
            classList: { add: vi.fn() }
        };
        const { context, calls } = loadListUi({ modal: { querySelectorAll: () => [] }, window: { MapShell: { coversMap: () => true } } });

        await context.handleProposalListItemClick(clickEvent(row));

        expect(context.previewProposalOnMap).not.toHaveBeenCalled();
        expect(row.classList.add).not.toHaveBeenCalled();
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('details');
        expect(calls[0][2]).toMatchObject({ centerOnProposal: true, closeSheets: true, presentation: 'compact' });
    });

    it('on a phone, Details still opens the full panel, centred since nothing framed it', async () => {
        const { context, calls } = loadListUi({ window: { MapShell: { coversMap: () => true } } });
        const button = { getAttribute: name => name === 'data-proposal-details' ? 'proposal-17' : null };

        await context.handleProposalListDetailsClick(clickEvent(button));

        expect(calls[0][2]).toMatchObject({ centerOnProposal: true, closeSheets: true, presentation: 'details' });
    });
});

describe('proposal panel fit padding', () => {
    const { context } = loadListUi();
    const pad = (rect, viewport) => JSON.parse(JSON.stringify(context.proposalPanelFitPadding(rect, viewport, 40)));
    const box = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
    const desktop = { width: 1280, height: 860 };
    const phone = { width: 390, height: 844 };

    it('pads only the margin when no panel is open', () => {
        expect(pad(null, desktop)).toEqual({ paddingTopLeft: [40, 40], paddingBottomRight: [40, 40] });
    });

    it('frames left of a panel docked on the right', () => {
        expect(pad(box(870, 58, 1270, 802), desktop)).toEqual({ paddingTopLeft: [40, 40], paddingBottomRight: [450, 40] });
    });

    // The list sheet sits centred over the dock: content goes to the free side, never under it.
    it('frames on the free side of a centred sheet, and right of a panel docked on the left', () => {
        expect(pad(box(360, 114, 920, 802), desktop)).toEqual({ paddingTopLeft: [40, 40], paddingBottomRight: [960, 40] });
        expect(pad(box(10, 58, 410, 802), desktop)).toEqual({ paddingTopLeft: [450, 40], paddingBottomRight: [40, 40] });
    });

    it('frames above a card across the width of a phone', () => {
        expect(pad(box(0, 505, 390, 786), phone)).toEqual({ paddingTopLeft: [40, 40], paddingBottomRight: [40, 379] });
    });

    it('uses the visible agreement panel when fitting its comparison on desktop and phone', () => {
        for (const [viewport, rect, expected] of [
            [desktop, box(870, 58, 1270, 802), [450, 40]],
            [phone, box(0, 362, 390, 784), [40, 522]]
        ]) {
            const panel = { classList: { contains: () => true }, getBoundingClientRect: () => rect };
            const { context } = loadListUi({
                window: { innerWidth: viewport.width, innerHeight: viewport.height },
                document: { addEventListener() {}, querySelector: () => null, getElementById: id => id === 'agreement-panel' ? panel : null }
            });
            expect(context.getProposalPanelFitPadding(40)).toEqual({ paddingTopLeft: [40, 40], paddingBottomRight: expected });
        }
    });

    it('pads nothing for a sheet covering the whole map: the framing is for when it closes', () => {
        expect(pad(box(0, 0, 390, 784), phone)).toEqual({ paddingTopLeft: [40, 40], paddingBottomRight: [40, 40] });
    });
});

describe('proposal list titles and descriptions', () => {
    const CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
    const { context } = loadListUi({ context: {
        resolveStructureProposal: () => null,
        resolveProposalGoalKey: () => '',
        getProposalGoalLabel: () => '',
        isGenericProposalDisplayText: coreFunction('isGenericProposalDisplayText')
    } });
    // Fields a minted proposal used to carry; designs are not minted (M3) and nothing writes them.
    const chainLeftovers = {
        tokenId: '7',
        metadata: { name: 'NFT name', properties: { title: 'NFT title' }, description: 'NFT text' },
        onchain: { proposalId: 'Acc', metadata: { name: 'Minted name', title: 'Minted title', description: 'Minted text' } }
    };

    it('names a record by its own text, else by its CID or local key, never by a chain token or its metadata', () => {
        expect(context.getProposalDisplayTitle({ title: 'Pocket park', ...chainLeftovers })).toBe('Pocket park');
        expect(context.getProposalDisplayTitle({ proposalId: 'p-1gtz1npm44n', ...chainLeftovers })).toBe('Design p-1gtz1npm44n');
        expect(context.getProposalDisplayTitle({ proposalId: `design-${CID}`, published: { cid: CID }, ...chainLeftovers })).toBe(`Design ${CID}`);
        expect(context.getProposalDisplayTitle({ cid: CID, ...chainLeftovers })).toBe(`Design ${CID}`);
        // "Minted proposal from …" was the generic title of a chain import; nothing imports one any more,
        // so such a title is an ordinary one.
        expect(context.getProposalDisplayTitle({ title: 'Minted proposal from Solana' })).toBe('Minted proposal from Solana');
        expect(context.getProposalDisplayTitle({ title: 'Proposal #12', proposalId: 'p-1' })).toBe('Design p-1');
    });

    it('describes a record by its own description only', () => {
        expect(context.getProposalDisplayDescription({ proposalId: 'p-1', ...chainLeftovers })).toBe('');
        expect(context.getProposalDisplayDescription({ description: 'Two rows of trees', ...chainLeftovers })).toBe('Two rows of trees');
    });
});
