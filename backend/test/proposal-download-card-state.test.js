// A downloaded proposal must stop offering to be downloaded.
//
// There are two ways to download one, and only one of them used to say so. The card's own Download
// button did a surgical update — label to "Downloaded", disabled, thumbnail upgraded, Local count
// bumped — deliberately avoiding a rerender so scroll position and the previewing row survive.
// Clicking the ROW downloads too (it asks first), and did none of that, so the card sat there still
// advertising a proposal the app already held.
//
// The fix is one shared step, so the two paths cannot drift again. These tests run the real function
// against a small fake DOM, plus a source check that the row path actually calls it — the row
// handler itself is too entangled with the modal to execute here, and a shared helper nobody calls
// would pass every test in this file.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const coreSource = read('../../frontend/js/proposals/core.js');
const listUiSource = read('../../frontend/js/proposals/list-ui.js');

// Lift the real functions out of the classic script and run them with everything they touch stubbed.
function lift(name) {
    const start = coreSource.indexOf(`function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const end = coreSource.indexOf('\n}', start);
    return coreSource.slice(start, end + 2);
}

function loadMarker(env) {
    const source = `${lift('addLocalBadgeToCard')}\n${lift('markProposalCardDownloaded')}`;
    // eslint-disable-next-line no-new-func
    return new Function(
        'document', 'proposalStorage', 'getProposalI18nHelper', 'CustomEvent', 'escapeHtml',
        `${source}; return markProposalCardDownloaded;`
    )(env.document, env.proposalStorage, () => env.t, env.CustomEvent, s => String(s));
}

// A card is a download button sitting inside an item that also holds the badge row, which is what
// the Local badge is inserted into.
function card(attrs) {
    const badges = [];
    const mintBadge = {
        className: 'proposal-mint-state',
        insertAdjacentHTML: (where, html) => { badges.push({ where, html }); }
    };
    const item = {
        badges,
        querySelector: sel => {
            if (sel === '.proposal-local-state') {
                return badges.some(b => b.html.includes('proposal-local-state')) ? {} : null;
            }
            if (sel === '.proposal-mint-state') return mintBadge;
            return null;
        }
    };
    const btn = {
        textContent: 'Download',
        disabled: false,
        getAttribute: name => (name in attrs ? attrs[name] : null),
        closest: sel => (sel === '.proposal-list-item' ? item : null),
        card: item
    };
    return btn;
}

const button = card;

let env;
let buttons;
let localToggle;
let dispatched;

beforeEach(() => {
    buttons = [
        button({ 'data-proposal-id': 'p-one', 'data-server-id': '101' }),
        button({ 'data-proposal-id': 'HR-330337-*879/2#plan-1', 'data-server-id': '102' })
    ];
    localToggle = { textContent: 'Local (7)' };
    dispatched = [];
    env = {
        document: {
            querySelectorAll: sel => (sel === '.proposal-download-btn' ? buttons : []),
            querySelector: sel => (sel.includes('data-source="local"') ? localToggle : null),
            dispatchEvent: e => { dispatched.push(e); return true; }
        },
        proposalStorage: { getAllProposals: () => new Array(8) },
        t: (key, fallback) => fallback,
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
    };
});

describe('the card stops offering a download', () => {
    it('disables the matching button and relabels it', () => {
        loadMarker(env)('p-one', { proposalId: 'p-one' });
        expect(buttons[0].textContent).toBe('Downloaded');
        expect(buttons[0].disabled).toBe(true);
    });

    it('leaves every other card alone', () => {
        loadMarker(env)('p-one', { proposalId: 'p-one' });
        expect(buttons[1].textContent).toBe('Download');
        expect(buttons[1].disabled).toBe(false);
    });

    it('matches on the server id too, since that is what one caller holds', () => {
        loadMarker(env)('102', { proposalId: 'x' });
        expect(buttons[1].textContent).toBe('Downloaded');
    });

    it('matches an id carrying characters a CSS selector would choke on', () => {
        // Exactly why the lookup compares attributes instead of building a selector.
        loadMarker(env)('HR-330337-*879/2#plan-1', { proposalId: 'x' });
        expect(buttons[1].disabled).toBe(true);
    });

    it('counts the new local proposal in the source toggle', () => {
        loadMarker(env)('p-one', { proposalId: 'p-one' });
        expect(localToggle.textContent).toBe('Local (8)');
    });
});

describe('the card says it is now held locally', () => {
    it('adds a Local badge next to the mint state', () => {
        loadMarker(env)('p-one', { proposalId: 'p-one' });
        expect(buttons[0].card.badges).toHaveLength(1);
        expect(buttons[0].card.badges[0].where).toBe('afterend');
        expect(buttons[0].card.badges[0].html).toContain('proposal-local-state');
        expect(buttons[0].card.badges[0].html).toContain('Local');
    });

    it('does not touch the other card', () => {
        loadMarker(env)('p-one', { proposalId: 'p-one' });
        expect(buttons[1].card.badges).toEqual([]);
    });

    it('never stacks a second badge on a card that already has one', () => {
        const mark = loadMarker(env);
        mark('p-one', { proposalId: 'p-one' });
        mark('p-one', { proposalId: 'p-one' });
        expect(buttons[0].card.badges).toHaveLength(1);
    });
});

describe('the thumbnail', () => {
    it('announces an image so the placeholder can be replaced', () => {
        loadMarker(env)('p-one', { proposalId: 'p-one', screenshotUrl: 'https://example.test/a.png' });
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0].type).toBe('proposalScreenshotUpdated');
        expect(dispatched[0].detail).toMatchObject({ proposalId: 'p-one', screenshotUrl: 'https://example.test/a.png' });
    });

    it('finds an image nested under the onchain record', () => {
        loadMarker(env)('p-one', { onchain: { imageUrl: 'ipfs://x' } });
        expect(dispatched[0].detail.screenshotUrl).toBe('ipfs://x');
    });

    it('says nothing when there is no image to announce', () => {
        loadMarker(env)('p-one', { proposalId: 'p-one' });
        expect(dispatched).toEqual([]);
    });
});

describe('degenerate input', () => {
    it('does nothing at all without an imported proposal', () => {
        loadMarker(env)('p-one', null);
        expect(buttons[0].textContent).toBe('Download');
        expect(localToggle.textContent).toBe('Local (7)');
    });

    it('still refreshes the count when the card is no longer on screen', () => {
        buttons = [];
        loadMarker(env)('p-gone', { proposalId: 'p-gone' });
        expect(localToggle.textContent).toBe('Local (8)');
    });
});

describe('the renderer shows it in both tabs', () => {
    const listSection = listUiSource.slice(
        listUiSource.indexOf('const downloadEligible'),
        listUiSource.indexOf('function clearProposalListFilterInputDebounce')
    );

    it('decides "local" from storage, not from which tab is open', () => {
        // downloadedLookup asks proposalStorage, so a proposal downloaded from the Server tab and one
        // sitting in the Local tab answer the same way — which is what makes the badge mean one thing.
        expect(listSection).toMatch(/const isLocal = typeof downloadedLookup === 'function'/);
    });

    it('renders the badge only when the proposal is held locally', () => {
        expect(listSection).toMatch(/\$\{isLocal \? `<span class="proposal-mint-state[^`]*proposal-local-state/);
    });

    it('keeps it distinct from the mint state rather than replacing it', () => {
        // "On server" and "Local" are independent facts and a downloaded proposal is both.
        const badgeRow = listSection.slice(listSection.indexOf('proposal-card-badges'));
        expect(badgeRow).toMatch(/escapeHtml\(mintLabel\)/);
        expect(badgeRow).toMatch(/escapeHtml\(mintLabels\.local\)/);
    });

    it.each(['en', 'hr', 'sr', 'es'])('%s has a translation for it', locale => {
        const dict = JSON.parse(read(`../../frontend/i18n/${locale}.json`));
        const label = dict.modal.roadWidth.proposalList.labels.local;
        expect(label, `${locale} is missing labels.local`).toBeTruthy();
        expect(typeof label).toBe('string');
    });
});

describe('both download paths use it', () => {
    it('the row-click path marks the card after importing', () => {
        const download = listUiSource.slice(listUiSource.indexOf('let justDownloaded = false;'));
        const block = download.slice(0, download.indexOf('if (!proposal) return;'));
        expect(block).toMatch(/markProposalCardDownloaded\(/);
    });

    it('the download button path marks the card too, and no longer inlines it', () => {
        const handler = coreSource.slice(coreSource.indexOf('async function handleProposalDownloadClick'));
        const body = handler.slice(0, handler.indexOf('\n}\n'));
        expect(body).toMatch(/markProposalCardDownloaded\(/);
        // The surgical update lives in one place now; a second copy is how they drifted apart.
        expect(body).not.toMatch(/proposalScreenshotUpdated/);
    });
});
