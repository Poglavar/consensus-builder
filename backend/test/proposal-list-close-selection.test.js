// Closing the proposal list keeps the proposal you were browsing.
//
// A list click only PREVIEWS, so before this the list could be closed on a proposal the user had
// clearly chosen and the map would be left holding a highlight that belonged to nothing selected —
// none of the proposal's own buttons reachable, and the same proposal had to be hunted down and
// clicked again on the map.
//
// The delicate half is WHICH closes may do it. Six callers close this list and only one is a genuine
// dismissal; the rest are either mid-selection already, or on their way out of proposals entirely,
// where re-selecting would reopen something the user just dismissed or deleted. So promotion is
// opt-in, and these tests pin the opt-in rather than the convenience.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const listUi = read('../../frontend/js/proposals/list-ui.js');
const dialogShare = read('../../frontend/js/proposals/dialog-share.js');
const layerRender = read('../../frontend/js/proposals/layer-render.js');

// Run the real function with every collaborator stubbed, so this exercises the shipped source.
function loadCloseProposalList(env) {
    const start = listUi.indexOf('function closeProposalList(options = {})');
    expect(start, 'closeProposalList not found').toBeGreaterThan(-1);
    const end = listUi.indexOf('\n}', start);
    const source = listUi.slice(start, end + 2);
    // eslint-disable-next-line no-new-func
    return new Function(
        'document', 'window', 'proposalListState', 'selectAndHighlightProposal',
        'clearProposalHighlights', 'clearProposalInfoHoverOverlay', 'console',
        `${source}; return closeProposalList;`
    )(
        env.document, env.window, env.proposalListState, env.selectAndHighlightProposal,
        env.clearProposalHighlights, env.clearProposalInfoHoverOverlay, env.console
    );
}

let env;
let selected;
let cleared;

function makeEnv({ previewingId = 'p-42', hasModal = true } = {}) {
    selected = [];
    cleared = 0;
    const modal = hasModal ? { style: { display: 'block' } } : null;
    const previewing = previewingId
        ? { getAttribute: name => (name === 'data-proposal-id' ? previewingId : null) }
        : null;
    return {
        document: {
            querySelector: sel => {
                if (sel === '.proposal-list-modal') return modal;
                if (sel === '.proposal-list-item.is-previewing') return previewing;
                return null;
            }
        },
        window: { proposalListBrowseMode: true },
        proposalListState: { selectedId: 'stale' },
        selectAndHighlightProposal: (...args) => { selected.push(args); },
        clearProposalHighlights: () => { cleared += 1; },
        clearProposalInfoHoverOverlay: () => {},
        console: { warn: () => {} },
        modal
    };
}

beforeEach(() => { env = makeEnv(); });

describe('closing the list on a previewed proposal', () => {
    it('selects it when the close is a genuine dismissal', () => {
        loadCloseProposalList(env)({ selectPreviewed: true });
        expect(selected).toHaveLength(1);
        expect(selected[0][0]).toBe('p-42');
    });

    it('opens the details panel, which is where Apply lives', () => {
        loadCloseProposalList(env)({ selectPreviewed: true });
        // (id, parcelId, shouldCenter, showDetails)
        expect(selected[0][3]).toBe(true);
    });

    it('does not move the map again — the preview already framed it', () => {
        loadCloseProposalList(env)({ selectPreviewed: true });
        expect(selected[0][2]).toBe(false);
    });

    it('keeps the highlights it is about to select, rather than clearing them first', () => {
        loadCloseProposalList(env)({ selectPreviewed: true });
        expect(cleared).toBe(0);
    });

    it('leaves browse mode before selecting, so the selection cannot re-close the list', () => {
        // selectAndHighlightProposal closes the list itself while browse mode is on; if the flag were
        // still set when it runs, this would recurse.
        env.selectAndHighlightProposal = () => {
            expect(env.window.proposalListBrowseMode).toBe(false);
            selected.push(['checked']);
        };
        loadCloseProposalList(env)({ selectPreviewed: true });
        expect(selected).toHaveLength(1);
    });
});

describe('closes that must NOT select anything', () => {
    it('a plain close leaves nothing selected and clears the highlights', () => {
        loadCloseProposalList(env)();
        expect(selected).toEqual([]);
        expect(cleared).toBe(1);
    });

    it('a mid-selection close does not select the previewed row on top of the real one', () => {
        loadCloseProposalList(env)({ clearHighlights: false });
        expect(selected).toEqual([]);
    });

    it('selects nothing when no row was being previewed', () => {
        env = makeEnv({ previewingId: null });
        loadCloseProposalList(env)({ selectPreviewed: true });
        expect(selected).toEqual([]);
    });

    it('survives a torn-down list with no modal in the DOM', () => {
        env = makeEnv({ hasModal: false });
        expect(() => loadCloseProposalList(env)({ selectPreviewed: true })).not.toThrow();
    });
});

describe('caller wiring', () => {
    it('the list dismiss button asks for it', () => {
        expect(dialogShare).toMatch(/closeProposalList\(\{ selectPreviewed: true \}\)/);
    });

    it('the map-selection path does not', () => {
        const tail = layerRender.slice(layerRender.indexOf('proposalListBrowseMode && showDetails'));
        expect(tail.slice(0, 200)).not.toMatch(/selectPreviewed/);
    });

    it('no other caller opts in — leaving proposals must not reopen one', () => {
        // Code lines only: the option is named in prose in a couple of comments, which is
        // documentation rather than a second caller.
        const callSites = [listUi, dialogShare, layerRender]
            .join('\n')
            .split('\n')
            .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
            .filter(line => /closeProposalList\(\s*\{[^}]*selectPreviewed:\s*true/.test(line));
        expect(callSites).toHaveLength(1);
        expect(callSites[0]).toMatch(/proposal-list-modal-close/);
    });
});
