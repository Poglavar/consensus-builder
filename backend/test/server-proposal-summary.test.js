// Unit test for normalizeServerProposalSummary (frontend/js/proposals/server-sync.js): the mapper
// that turns a row from GET /proposals/summary into the object the proposal list renders.
//
// It exists because that mapper silently dropped `screenshotUrl`, so every row in the list's Server
// tab fell back to the goal emoji even though the server had rendered a thumbnail for nearly all of
// them. The field is only ever read by buildProposalThumbHtml, so nothing else noticed.
//
// server-sync.js is a classic script with no exports that reads cross-file globals, so it is
// evaluated in a vm context with the two globals this function touches stubbed in.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../../frontend/js/proposals/server-sync.js');

function loadNormalizer() {
    const context = createContext({
        window: undefined,
        console,
        normalizeProposalGoalKey: goal => (goal || '').toString().trim().toLowerCase(),
        getCurrentCityId: () => 'zagreb'
    });
    runInContext(readFileSync(scriptPath, 'utf8'), context);
    return context.normalizeServerProposalSummary;
}

describe('normalizeServerProposalSummary', () => {
    const normalizeServerProposalSummary = loadNormalizer();

    // The shape GET /proposals/summary actually returns (verified against api.urbangametheory.xyz).
    const summaryRow = {
        id: 62,
        proposalId: 'p-9qg43kxlmm',
        city: 'zagreb',
        name: 'Road 1407-0247',
        title: 'Road 1407-0247',
        author: 'Guest 9888',
        type: 'road',
        status: 'Active',
        createdAt: '2026-07-14T00:47:49.263Z',
        screenshotUrl: 'https://api.urbangametheory.xyz/uploads/images/proposal-thumb-62-1784065207119.png'
    };

    it('carries the server-rendered thumbnail url through to the list item', () => {
        const normalized = normalizeServerProposalSummary(summaryRow, 'zagreb');
        expect(normalized.screenshotUrl).toBe(summaryRow.screenshotUrl);
    });

    it('accepts the snake_case spelling too', () => {
        const { screenshotUrl, ...snake } = summaryRow;
        snake.screenshot_url = screenshotUrl;
        expect(normalizeServerProposalSummary(snake, 'zagreb').screenshotUrl).toBe(screenshotUrl);
    });

    it('leaves screenshotUrl null when the server has no thumbnail for the proposal', () => {
        const { screenshotUrl, ...withoutThumb } = summaryRow;
        expect(normalizeServerProposalSummary(withoutThumb, 'zagreb').screenshotUrl).toBeNull();
    });

    it('still maps the identifying fields the list keys off', () => {
        const normalized = normalizeServerProposalSummary(summaryRow, 'zagreb');
        expect(normalized.serverProposalId).toBe('62');
        expect(normalized.proposalId).toBe('p-9qg43kxlmm');
        expect(normalized.city).toBe('zagreb');
    });
});

describe('serverListQuery (server-side search/sort mapping)', () => {
    // Load the script into a context we can mutate proposalListState on.
    function loadWithState(state) {
        const context = createContext({
            window: undefined,
            console,
            normalizeProposalGoalKey: goal => (goal || '').toString().trim().toLowerCase(),
            getCurrentCityId: () => 'zagreb',
            proposalListState: state
        });
        runInContext(readFileSync(scriptPath, 'utf8'), context);
        return context;
    }

    it('passes the trimmed search text as q', () => {
        const ctx = loadWithState({ source: 'server', searchText: '  ilica  ', sortKey: 'created-desc' });
        expect(ctx.serverListQuery().q).toBe('ilica');
    });

    it('only forwards DB-derivable sort keys; computed ones stay client-side', () => {
        expect(loadWithState({ sortKey: 'value-desc' }).serverListQuery().sort).toBe('value-desc');
        expect(loadWithState({ sortKey: 'created-asc' }).serverListQuery().sort).toBe('created-asc');
        // area/acceptance/parcels are computed client-side → not sent (empty = server default)
        expect(loadWithState({ sortKey: 'area-desc' }).serverListQuery().sort).toBe('');
        expect(loadWithState({ sortKey: 'acceptance-desc' }).serverListQuery().sort).toBe('');
    });

    it('signature changes when the query changes, and is stable otherwise', () => {
        const a = loadWithState({ searchText: 'foo', sortKey: 'value-desc' }).serverListQuerySignature();
        const b = loadWithState({ searchText: 'foo', sortKey: 'value-desc' }).serverListQuerySignature();
        const c = loadWithState({ searchText: 'bar', sortKey: 'value-desc' }).serverListQuerySignature();
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });

    it('isServerListTab reflects the active source', () => {
        expect(loadWithState({ source: 'server' }).isServerListTab()).toBe(true);
        expect(loadWithState({ source: 'local' }).isServerListTab()).toBe(false);
    });
});
