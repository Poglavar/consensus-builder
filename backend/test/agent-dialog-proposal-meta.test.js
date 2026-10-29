// The agent dialog badges each of an agent's designs with the ladder rung every list shows
// (agents.js agentProposalLifecycleBadgeHtml over proposals/display-state.js). It used to call every
// id that did not start with "local-" minted, so once local ids became content hashes (p-…) every
// proposal the simulation agents created showed as Minted. A design is never minted
// (plan-design-agreement.md, M3): it reads Draft, or Published while it hashes to its published CID.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from '@babel/parser';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const displayState = require('../../frontend/js/proposals/display-state.js');
const { publishedCid } = require('../../frontend/js/proposals/design-sync.js');
const DesignRecord = require('../../frontend/js/design-record.js');
const API = 'https://api.example.test';

function functionSources(file, names) {
    const source = readFileSync(new URL(`../../frontend/js/${file}`, import.meta.url), 'utf8');
    const ast = parse(source, { sourceType: 'script' });
    return names.map(name => {
        const node = ast.program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === name);
        if (!node) throw new Error(`${name} not found in ${file}`);
        return source.slice(node.start, node.end);
    }).join('\n');
}

const code = functionSources('agents.js', ['getI18nApi', 'formatString', 'translateText', 'agentProposalLifecycleBadgeHtml']);
const lifecycleLabel = key => ({ cancelled: 'Withdrawn', expired: 'Expired' })[key] || key;
const badgeOf = new Function('window', 'getProposalLifecycleLabel', `${code}\nreturn agentProposalLifecycleBadgeHtml;`)(
    { __proposalDisplayState: displayState, i18n: null }, lifecycleLabel);

const SITE = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.801], [15.97, 45.8]]] };
const park = (extra = {}) => ({ proposalId: 'p-1gtz1npm44n', goal: 'park', title: 'Pocket park', site: SITE, lifecycleStatus: 'Active',
    createdAt: '2026-10-01T12:00:00.000Z', structureProposal: { kind: 'park', geometry: SITE }, ...extra });
const DRAFT = '<span class="cb-badge cb-badge--draft">Draft</span>';

afterEach(() => vi.unstubAllGlobals());

describe('agent dialog proposal title', () => {
    const titleOf = new Function(`${functionSources('agents.js', ['getAgentProposalTitle'])}\nreturn getAgentProposalTitle;`)();

    it('names a design by its own title, never by a chain token\'s metadata (designs are not minted, M3)', () => {
        expect(titleOf(park())).toBe('Pocket park');
        expect(titleOf({ goal: 'park', onchain: { metadata: { name: 'Minted name', title: 'Minted title' } } }, 'p-1')).toBe('Design p-1');
        expect(titleOf({ goal: 'park', metadata: { name: 'NFT name', title: 'NFT title' } }, 'p-1')).toBe('Design p-1');
    });
});

describe('agent dialog proposal badge', () => {
    it('badges a local design Draft whatever its id looks like', () => {
        for (const proposalId of ['p-1gtz1npm44n', '780', 'local-7']) {
            expect(badgeOf(park({ proposalId })), proposalId).toBe(DRAFT);
        }
    });

    it('badges a design Published only while it hashes to the CID it was published as at this index', () => {
        vi.stubGlobal('DesignSync', { publishedCid: record => publishedCid(record, API) });
        const record = park();
        const published = { ...record, published: { cid: DesignRecord.cidOf(record), publishedAt: '2026-10-02T08:00:00.000Z', apiBase: API } };
        expect(badgeOf(published)).toBe('<span class="cb-badge cb-badge--published">Published</span>');
        // Edited after publishing: another design than the one published.
        expect(badgeOf({ ...published, title: 'Pocket park, wider' })).toBe(DRAFT);
    });

    it('adds the lifecycle modifier beside the rung, and no badge for an unloaded record', () => {
        expect(badgeOf(park({ lifecycleStatus: 'Cancelled' })))
            .toBe(`${DRAFT}<span class="cb-badge cb-badge--expired">Withdrawn</span>`);
        expect(badgeOf(null)).toBe('');
    });
});
