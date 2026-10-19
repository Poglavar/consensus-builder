/* The share-plan panel decides "is this already on the server?" from ONE listing fetched with
   ?city=<current>. That list is authoritative only for that city, so a proposal stored without a
   city — or under another — is absent from it while sitting happily on the server, and the row
   invites you to upload something that is already there.

   Found on the real plan: sibenik-2066-1 holds 299 proposals, 298 with city='sibenik' and exactly
   one, id 701 "Sibenik 4 — track 1" (transit-project-141-track-1), with city NULL. GET
   /proposals/summary?city=sibenik returns 379 rows and 701 is not among them; GET /proposals/701
   answers 200. So the panel offered to upload it.

   That is worse than a wrong label: accepting the offer writes a SECOND copy. The database already
   holds id 703, `transit-project-141-track-1-ko330337`, city 'sibenik', created the same day —
   which is what a re-upload of 701 under a city looks like.

   Pinned here: a miss in the city list is confirmed per proposal before it is reported as missing. */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dialogShare = read('../../frontend/js/proposals/dialog-share.js');

function sliceBetween(src, from, to) {
    const start = src.indexOf(from);
    expect(start, `missing marker: ${from}`).toBeGreaterThan(-1);
    const end = src.indexOf(to, start);
    expect(end, `missing marker after it: ${to}`).toBeGreaterThan(start);
    return src.slice(start, end);
}

// The decision itself, lifted out and run — the surrounding function is all DOM.
const decision = sliceBetween(dialogShare,
    'let exists = (known instanceof Set)',
    'const refreshedProposal =');

function decide({ known, serverId, headAnswers }) {
    const headProposalExists = vi.fn(async () => headAnswers);
    const run = new Function('known', 'serverId', 'proposal', 'headProposalExists',
        `return (async () => { ${decision} return exists; })();`);
    return { promise: run(known, serverId, { city: null }, headProposalExists), headProposalExists };
}

describe('a miss in the city-scoped list is not proof of absence', () => {
    it('the real case: city-less proposal absent from a city list, present on the server', async () => {
        // The list came back fine — it simply does not cover a proposal with no city.
        const known = new Set(['703', 'transit-project-141-track-1-ko330337']);
        const { promise, headProposalExists } = decide({
            known, serverId: '701', headAnswers: true
        });
        await expect(promise).resolves.toBe(true);
        expect(headProposalExists, 'a miss must be confirmed, not trusted').toHaveBeenCalledTimes(1);
    });

    it('still reports genuinely absent proposals as absent', async () => {
        const known = new Set(['703']);
        const { promise, headProposalExists } = decide({
            known, serverId: '999999', headAnswers: false
        });
        await expect(promise).resolves.toBe(false);
        expect(headProposalExists).toHaveBeenCalledTimes(1);
    });

    it('costs nothing for the rows that ARE in the list', async () => {
        const known = new Set(['701']);
        const { promise, headProposalExists } = decide({
            known, serverId: '701', headAnswers: false
        });
        await expect(promise).resolves.toBe(true);
        expect(headProposalExists, 'a hit must not trigger a request').not.toHaveBeenCalled();
    });

    it('keeps asking per proposal when no list could be fetched at all', async () => {
        const { promise, headProposalExists } = decide({
            known: null, serverId: '701', headAnswers: true
        });
        await expect(promise).resolves.toBe(true);
        expect(headProposalExists).toHaveBeenCalledTimes(1);
    });
});

describe('the reason is written down where the decision is made', () => {
    it('says why a miss cannot be trusted', () => {
        const context = sliceBetween(dialogShare,
            '// `known` is the whole server list',
            'const refreshedProposal =');
        expect(context).toMatch(/authoritative only FOR ITS CITY/i);
        // The consequence is the point: a false miss creates a duplicate.
        expect(context).toMatch(/SECOND copy/i);
    });
});
