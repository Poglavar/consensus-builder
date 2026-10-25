// Reverse membership navigation: exact revisions, local drafts, independent failures, pagination and stale requests.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { makeDocument } from './helpers/fake-dom.js';
const require = createRequire(import.meta.url);
const { localAgreements, mergeRows, fetchPage, mount, strings } = require('../../frontend/js/design-memberships.js');

const page = (kind, items = [], nextOffset = null) => Response.json({ [kind]: items, hasMore: nextOffset !== null, nextOffset });
function fixture({ published = true, agreements = [], language = 'en', fetch = vi.fn(async url => page(new URL(url).pathname.slice(1))) } = {}) {
    const doc = makeDocument(), host = doc.createElement('section'); doc.body.appendChild(host);
    const dictionaries = {};
    const win = { fetch, location: new URL('https://app.example/?backend=https%3A%2F%2Fapi.example'), console: { warn: vi.fn() }, resolveBackendBaseUrl: () => 'https://api.example',
        DesignSync: { publishedCid: proposal => proposal.cid || null },
        AgreementStore: { list: () => agreements }, AgreementRecord: { publishedCid: agreement => agreement.published?.cid },
        NamedPlans: { current: null, link: cid => `https://app.example/plans/${cid}?backend=https%3A%2F%2Fapi.example` },
        AgreementSync: { agreementLink: cid => `https://app.example/agreements/${cid}` },
        AgreementPanel: { open: vi.fn() }, showStyledAlert: vi.fn(),
        i18n: { registerTranslations(lang, values) { dictionaries[lang] = { ...dictionaries[lang], ...values }; }, t: key => dictionaries[language]?.[key] || key }
    };
    const proposal = { proposalId: 'local-design', ...(published ? { cid: 'design-current' } : {}) };
    return { host, win, proposal, group: kind => host.querySelector(`[data-membership-kind="${kind}"]`), open: () => mount(host, proposal, win) };
}
const draft = { id: 'draft-agreement', title: 'Local consultation', designs: [{ proposalId: 'local-design' }] };

describe('design memberships', () => {
    it('distinguishes exact published membership from local draft references and older revisions', () => {
        const agreements = [draft,
            { id: 'published', published: { cid: 'agreement-current' }, designs: [{ proposalId: 'different-local-copy', cid: 'design-current' }] },
            { id: 'old', published: { cid: 'agreement-old' }, designs: [{ proposalId: 'local-design', cid: 'design-old' }] }];
        expect(localAgreements('local-design', 'design-current', agreements, row => row.published?.cid || null).map(row => row.localId))
            .toEqual(['draft-agreement', 'published']);
        expect(localAgreements('local-design', null, agreements, row => row.published?.cid || null).map(row => row.localId))
            .toEqual(['draft-agreement']);
    });

    it('deduplicates published records while retaining their local navigation identity', () => {
        expect(mergeRows([{ cid: 'same', localId: 'here', title: 'Before' }], [{ cid: 'same', title: 'After' }]))
            .toEqual([{ cid: 'same', localId: 'here', title: 'After' }]);
    });

    it('lists an imported published agreement once after its local land has been reconstructed', async () => {
        const agreement = { id: 'imported', title: 'Published consultation', published: { cid: 'published-agreement', apiBase: 'https://api.example' },
            designs: [{ proposalId: 'local-design', cid: 'design-current' }], outputs: [{ pieceId: 'local-land-piece' }] };
        const f = fixture({ agreements: [agreement], fetch: vi.fn(async url => {
            const kind = new URL(url).pathname.slice(1);
            return page(kind, kind === 'agreements' ? [{ cid: 'published-agreement', title: 'Published consultation' }] : []);
        }) });
        f.win.AgreementRecord.publishedCid = () => { throw new Error('Local derived land is not canonical published content.'); };
        await f.open();
        expect(f.group('agreements').querySelectorAll('li')).toHaveLength(1);
        expect(f.group('agreements').querySelector('.design-memberships__draft')).toBeNull();
    });

    it('shows public plan and agreement links without restricting membership to the current city', async () => {
        const fetch = vi.fn(async url => page(new URL(url).pathname.slice(1), [{ cid: 'public-record', title: '<img src=x onerror=attack()>' }]));
        const f = fixture({ fetch }); await f.open();
        expect(fetch).toHaveBeenCalledTimes(2);
        for (const [url] of fetch.mock.calls) {
            expect(new URL(url).searchParams.get('design')).toBe('design-current');
            expect(new URL(url).searchParams.has('city')).toBe(false);
        }
        expect(f.group('plans').querySelector('a').href).toContain('/plans/public-record?backend=');
        expect(f.group('agreements').querySelector('a').href).toContain('/agreements/public-record?backend=');
        expect(f.host.querySelector('img')).toBeNull();
        expect(f.host.textContent).toContain('<img src=x onerror=attack()>');
    });

    it('opens local drafts without treating the unpublished design as a published revision', async () => {
        const f = fixture({ published: false, agreements: [draft] }); await f.open();
        expect(f.win.fetch).not.toHaveBeenCalled();
        expect(f.host.textContent).toContain('Publish this revision');
        expect(f.group('agreements').textContent).toContain('Draft');
        f.group('agreements').querySelector('button').click();
        expect(f.win.AgreementPanel.open).toHaveBeenCalledWith('draft-agreement');
    });

    it('retains one successful list and local drafts when the other lookup fails, then retries only the failure', async () => {
        let planFailed = true;
        const fetch = vi.fn(async url => {
            const kind = new URL(url).pathname.slice(1);
            return kind === 'plans' && planFailed ? new Response('', { status: 503 }) : page(kind, [{ cid: `${kind}-one`, title: `${kind} result` }]);
        });
        const f = fixture({ fetch, agreements: [draft] }); await f.open();
        expect(f.group('agreements').textContent).toContain('agreements result');
        expect(f.group('agreements').textContent).toContain('Local consultation');
        expect(f.group('plans').textContent).toContain('Could not load');
        expect(f.group('plans').textContent).not.toContain('None');
        planFailed = false;
        f.group('plans').querySelector('button').click();
        await vi.waitFor(() => expect(f.group('plans').textContent).toContain('plans result'));
        expect(fetch.mock.calls.filter(([url]) => url.includes('/agreements?'))).toHaveLength(1);
    });

    it('explains when a local agreement can no longer be opened', async () => {
        const f = fixture({ published: false, agreements: [draft] }); await f.open();
        f.win.AgreementPanel.open.mockRejectedValue(new Error('The agreement was removed.'));
        f.group('agreements').querySelector('button').click();
        await vi.waitFor(() => expect(f.win.showStyledAlert).toHaveBeenCalledWith('The agreement was removed.'));
    });

    it('loads further memberships without dropping earlier results', async () => {
        const fetch = vi.fn(async url => {
            const query = new URL(url), kind = query.pathname.slice(1), offset = Number(query.searchParams.get('offset'));
            return kind === 'agreements' ? page(kind) : page(kind,
                Array.from({ length: offset === 0 ? 5 : 2 }, (_, i) => ({ cid: `plan-${offset + i}`, title: `Plan ${offset + i}` })), offset === 0 ? 5 : null);
        });
        const f = fixture({ fetch }); await f.open();
        expect(f.group('plans').querySelectorAll('a')).toHaveLength(5);
        f.group('plans').querySelector('button').click();
        await vi.waitFor(() => expect(f.group('plans').querySelectorAll('a')).toHaveLength(7));
        expect(f.group('plans').querySelector('button')).toBeNull();
        expect(fetch.mock.calls.some(([url]) => new URL(url).searchParams.get('offset') === '5')).toBe(true);
    });

    it('does not let an older selection overwrite the current design membership', async () => {
        const pending = [];
        const fetch = vi.fn(url => new Promise(resolve => pending.push({ url, resolve })));
        const f = fixture({ fetch }); const old = f.open();
        const newer = mount(f.host, { proposalId: 'other', cid: 'design-newer' }, f.win);
        for (const row of pending.filter(row => row.url.includes('design-newer'))) row.resolve(page(new URL(row.url).pathname.slice(1), [{ cid: 'new-record', title: 'New selection' }]));
        await newer;
        for (const row of pending.filter(row => !row.url.includes('design-newer'))) row.resolve(page(new URL(row.url).pathname.slice(1), [{ cid: 'old-record', title: 'Old selection' }]));
        await old;
        expect(f.host.textContent).toContain('New selection');
        expect(f.host.textContent).not.toContain('Old selection');
    });

    it('keeps the currently open plan visible even when its remote listing cannot be read', async () => {
        const f = fixture({ fetch: vi.fn(async () => new Response('', { status: 503 })) });
        f.win.NamedPlans.current = { cid: 'open-plan', content: { title: 'Open plan', designCids: ['design-current'] } };
        await f.open();
        expect(f.group('plans').querySelector('a').textContent).toBe('Open plan');
        expect(f.group('plans').textContent).toContain('Could not load');
    });

    it.each(['en', 'hr', 'sr', 'es'])('renders membership labels in %s', async language => {
        const f = fixture({ language, published: false }); await f.open();
        expect(f.host.getAttribute('aria-label')).toBe(strings[language].title);
        expect(f.group('plans').textContent).toContain(strings[language].plans);
    });

    it('rejects malformed and nonadvancing pagination instead of hiding missing results', async () => {
        for (const payload of [{ plans: [] }, { plans: [], hasMore: true, nextOffset: 0 }]) {
            await expect(fetchPage({ fetch: async () => Response.json(payload), backend: 'https://api.example', kind: 'plans', designCid: 'design-current' })).rejects.toThrow(/Invalid membership/);
        }
    });
});
