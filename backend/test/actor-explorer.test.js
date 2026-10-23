// Headless tests for the data model that lets human, algorithmic and LLM activity share one UI. Every
// event is about an agreement or a design, named by its CID (plan-design-agreement.md, M3), so a row
// opens either through one entity link and scopes activity by agreement.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { activityRowHtml, actorKey, backendBase, buildActorProfiles, eventDetail, eventsInvolvingActor, filterEvents, mount, runCostTotal } = require('../../frontend/js/actor-explorer.js');

const AGREEMENT = 'bafkreiftzbz2gpufkdckedn2fgb6jiq3qxd6zeohfzmgm42rysek3kuf7y';
const MINTED = 'bafkreigb4spdl37uquwgdhzpvjfwicwgthlv2finkq5zibibrx66yk2eha';
const DESIGN = 'bafkreiehkrtqnkc7fjuviaz4oyqis7wexv3zsq3vfzknyf43rc5qvygce4';
const llm = { id: 'llm-1', name: 'Densifier', kind: 'agent', controller: 'llm', wallet: 'wallet-1' };

const events = [
    { id: 'human-pledge', actor: { id: 'person-1', name: 'Dana', kind: 'human', controller: 'human' }, action: { type: 'pledge', agreementCid: AGREEMENT }, entity: { type: 'agreement', id: AGREEMENT }, transaction: 'human-tx', recordedAt: '2026-09-20T10:00:00Z' },
    { id: 'algo-donation', actor: { id: 'algorithm-1', name: 'Block matcher', kind: 'agent', controller: 'algorithm' }, action: { type: 'donate', agreementCid: AGREEMENT }, entity: { type: 'agreement', id: AGREEMENT }, recordedAt: '2026-09-20T10:01:00Z' },
    { id: 'llm-mint', actor: llm, action: { type: 'mint', agreementCid: MINTED }, entity: { type: 'agreement', id: MINTED }, runId: 'run-1', model: 'model-x', batchId: 'batch-1', modelCostUsd: 0.0054, rationale: 'The parcel is underused.', transaction: 'mint-tx', recordedAt: '2026-09-20T10:02:00Z' },
    { id: 'llm-stake', actor: llm, action: { type: 'stake', agreementCid: MINTED, side: 'yes' }, entity: { type: 'agreement', id: MINTED }, runId: 'run-1', model: 'model-x', batchId: 'batch-1', modelCostUsd: 0.0054, transaction: 'stake-tx', recordedAt: '2026-09-20T10:03:00Z' },
    { id: 'llm-design', actor: llm, action: { type: 'design', designCid: DESIGN }, entity: { type: 'design', id: DESIGN }, runId: 'run-1', model: 'model-x', modelCostUsd: 0.0054, recordedAt: '2026-09-20T10:01:30Z' }
];

// The smallest DOM ActorExplorer.mount needs: elements that hold children, take listeners and a click.
class FakeNode {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = {}; this.attributes = {};
        this.className = ''; this.textContent = '';
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    click() { (this.listeners.click || []).forEach(listener => listener({ target: this })); }
    get childElementCount() { return this.children.length; }
    all() { return this.children.flatMap(child => [child, ...child.all()]); }
}

// mount() reads the document once, when it is called; the module itself loaded without one, so it
// did not boot the standalone page.
function mountExplorer(options) {
    const element = new FakeNode('div');
    const previous = globalThis.document;
    globalThis.document = { createElement: tagName => new FakeNode(tagName) };
    try {
        mount(element, options);
        return element;
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
}

describe('actor explorer view model', () => {
    it('profiles humans, algorithms and LLMs with the same activity representation', () => {
        const profiles = buildActorProfiles(events);
        expect(profiles.map(profile => profile.actor.controller).sort()).toEqual(['algorithm', 'human', 'llm']);
        const llmProfile = profiles.find(profile => profile.actor.controller === 'llm');
        // The design it published is its activity, but not one of its agreements.
        expect(llmProfile).toMatchObject({ activityCount: 3, agreementCids: [MINTED], transactionCount: 2, modelCostUsd: 0.0054 });
        expect(profiles.find(profile => profile.actor.controller === 'human').agreementCids).toEqual([AGREEMENT]);
    });

    it('uses wallet-or-id identity, so a persona stays together across algorithm and LLM runs', () => {
        const samePersona = [
            { id: 'algorithm-run', actor: { id: 'densifier-01', name: 'Densifier', controller: 'algorithm', wallet: 'wallet-d' }, action: { type: 'run_status' } },
            { id: 'llm-run', actor: { id: 'densifier-01', name: 'Densifier', controller: 'llm', wallet: 'wallet-d' }, action: { type: 'propose' } },
            { id: 'chain-stake', actor: { id: 'wallet-d', name: 'Densifier', controller: 'algorithm', wallet: 'wallet-d' }, action: { type: 'stake' } }
        ];
        expect(actorKey(samePersona[0].actor)).toBe('wallet-d');
        expect(buildActorProfiles(samePersona)).toHaveLength(1);
        expect(buildActorProfiles(samePersona)[0]).toMatchObject({ key: 'wallet-d', activityCount: 3 });
    });

    it('keeps absent actor provenance unknown instead of inventing an algorithmic actor', () => {
        const [profile] = buildActorProfiles([{ id: 'published-design', action: { type: 'design' } }]);
        expect(profile.actor).toMatchObject({ id: 'unknown', name: 'Unknown actor', kind: 'unknown', controller: 'unknown' });
        expect(filterEvents([{ id: 'published-design', action: { type: 'design' } }], { controller: 'algorithm' })).toEqual([]);
    });

    it('keeps actors with distinct wallets in separate profiles even if their names match', () => {
        const profiles = buildActorProfiles([
            { id: 'one', actor: { id: 'same-persona', name: 'Same persona', controller: 'algorithm', wallet: 'wallet-one' }, action: { type: 'run_status' } },
            { id: 'two', actor: { id: 'same-persona', name: 'Same persona', controller: 'llm', wallet: 'wallet-two' }, action: { type: 'run_status' } }
        ]);
        expect(profiles.map(profile => profile.key).sort()).toEqual(['wallet-one', 'wallet-two']);
    });

    it('filters across shared fields without hiding the non-LLM actor types', () => {
        expect(filterEvents(events, { controller: 'human' }).map(event => event.id)).toEqual(['human-pledge']);
        expect(filterEvents(events, { query: 'mint-tx' }).map(event => event.id)).toEqual(['llm-mint']);
        expect(filterEvents(events, { query: AGREEMENT }).map(event => event.id).sort()).toEqual(['algo-donation', 'human-pledge']);
        // A design is found by its CID too, also by its first characters.
        expect(filterEvents(events, { query: DESIGN.slice(0, 14) }).map(event => event.id)).toEqual(['llm-design']);
    });

    it('exposes rationale, cost/run and transaction provenance in event details', () => {
        expect(eventDetail(events[2])).toMatchObject({
            action: 'Minted', agreementCid: MINTED, designCid: null,
            rationale: 'The parcel is underused.', runId: 'run-1', modelCostUsd: 0.0054, transaction: 'mint-tx'
        });
        expect(eventDetail(events[4])).toMatchObject({ action: 'Published design', agreementCid: null, designCid: DESIGN });
        expect(runCostTotal({ costs: [{ usd: 0.0054 }, { usd: '0.001' }] })).toBeCloseTo(0.0064);
    });

    it('uses the public API host when the standalone explorer has no app runtime', () => {
        expect(backendBase()).toBe('https://api.urbangametheory.xyz');
    });

    it('renders human, algorithmic and LLM rows identically until Details is opened', () => {
        const shared = { source: 'live', message: 'Acted.', action: { type: 'donate', agreementCid: AGREEMENT }, entity: { type: 'agreement', id: AGREEMENT }, transaction: 'tx-1', occurredAt: '2026-09-20T10:00:00Z' };
        const rows = events.slice(0, 3).map(event => activityRowHtml({ ...shared, actor: event.actor }));
        const beforeDetails = rows.map(row => row.split('<details')[0]);
        expect(new Set(beforeDetails).size).toBe(1);
        expect(rows[2]).toMatch(/<details[^]*Controller: llm/);
        rows.forEach(row => expect(row).not.toMatch(/user-action|data-actor-kind/));
    });

    it('opens an agreement or a design through one entity link, and scopes activity by agreement', () => {
        const agreementRow = activityRowHtml({ source: 'live', action: { type: 'execute', agreementCid: AGREEMENT }, entity: { type: 'agreement', id: AGREEMENT } });
        expect(agreementRow).toContain(`<button type="button" class="cb-link activity-entity-link" data-entity-type="agreement" data-entity-id="${AGREEMENT}">Open agreement</button>`);
        expect(agreementRow).toContain(`data-activity-scope="agreementCid" data-activity-value="${AGREEMENT}">All activity on this agreement</button>`);
        expect(agreementRow).toContain(`<span>agreement: ${AGREEMENT}</span>`);

        const designRow = activityRowHtml({ source: 'live', action: { type: 'design', designCid: DESIGN }, entity: { type: 'design', id: DESIGN } });
        expect(designRow).toContain(`<button type="button" class="cb-link activity-entity-link" data-entity-type="design" data-entity-id="${DESIGN}">Open design</button>`);
        expect(designRow).not.toContain('data-activity-scope="agreementCid"');

        // A bet is about its market; the agreement it bets on rides on the action and still scopes it.
        const betRow = activityRowHtml({ source: 'live', action: { type: 'stake', agreementCid: AGREEMENT }, entity: { type: 'market', id: 'market-account' } });
        expect(betRow).not.toContain('activity-entity-link');
        expect(betRow).toContain(`data-activity-scope="agreementCid" data-activity-value="${AGREEMENT}"`);

        // A parcel is detail; there is nothing for the row to open or scope.
        const parcelRow = activityRowHtml({ source: 'live', action: { type: 'create', parcelId: 'P/1' }, entity: { type: 'parcel', id: 'P/1' } });
        expect(parcelRow).not.toMatch(/activity-entity-link|data-activity-scope="agreementCid"/);
        expect(parcelRow).toContain('<span>parcel: P/1</span>');

        const hostile = activityRowHtml({ source: 'live', action: { type: 'propose' }, entity: { type: 'agreement', id: 'x" onclick="alert(1)' } });
        expect(hostile).toContain('data-entity-id="x&quot; onclick=&quot;alert(1)"');
        expect(hostile).not.toContain('onclick="alert');
    });

    it('escapes live messages but keeps app-authored simulation markup and its turn', () => {
        const live = activityRowHtml({ source: 'live', message: '<img src=x onerror=alert(1)>', actor: { name: 'X' }, action: { type: 'donate' } });
        expect(live).toContain('&lt;img src=x');
        const simulation = activityRowHtml({ source: 'simulation', turn: 4, occurredAt: '2024-01-02T00:00:00Z', messageHtml: '<a class="agent-link-clickable" data-agent-id="a1">Ana</a> pledged' });
        expect(simulation).toContain('<a class="agent-link-clickable" data-agent-id="a1">Ana</a> pledged');
        expect(simulation).toContain('Turn 4 · ');
    });

    it('localizes row labels through the host translator and interpolates English fallbacks', () => {
        const event = { source: 'simulation', turn: 3, occurredAt: '2024-01-02T00:00:00Z', messageHtml: 'x', entity: { type: 'agreement', id: AGREEMENT }, actor: { id: 'a1' }, action: { type: 'donate' } };
        expect(activityRowHtml(event)).toContain('Turn 3 · ');
        const seen = [];
        const translate = (key, _fallback, params) => { seen.push(key); return `[${key}${params?.turn ?? ''}]`; };
        const row = activityRowHtml(event, { translate });
        expect(row).toContain('[gameDialogs.log.row.turn3]');
        expect(row).toContain('[gameDialogs.log.row.openAgreement]');
        expect(row).not.toMatch(/Open agreement|All activity on this agreement|>Details</);
        expect(seen).toEqual(expect.arrayContaining(['gameDialogs.log.row.scopeAgreement', 'gameDialogs.log.row.details']));
        const designRow = activityRowHtml({ ...event, entity: { type: 'design', id: DESIGN } }, { translate });
        expect(designRow).toContain('[gameDialogs.log.row.openDesign]');
        expect(designRow).not.toContain('Open design');
    });

    // i18n-locale-coverage.test.js cannot see these keys (the row assembles them from a prefix), so
    // every key the row asks its translator for is checked here, in all four locales.
    it('has every row label in every locale, and no label the row no longer asks for', () => {
        const source = readFileSync(new URL('../../frontend/js/actor-explorer.js', import.meta.url), 'utf8');
        const keys = [...new Set([...source.matchAll(/\btr\('([A-Za-z]+)'/g)].map(match => match[1]))];
        expect(keys).toEqual(expect.arrayContaining(['openAgreement', 'openDesign', 'scopeAgreement', 'details', 'turn']));
        for (const lang of ['en', 'hr', 'es', 'sr']) {
            const row = JSON.parse(readFileSync(new URL(`../../frontend/i18n/${lang}.json`, import.meta.url), 'utf8')).gameDialogs.log.row || {};
            expect(keys.filter(key => !row[key]), `${lang} lacks`).toEqual([]);
            expect(Object.keys(row).filter(key => !keys.includes(key)), `${lang} keeps`).toEqual([]);
        }
    });

    it('selects events performed by an actor or linking to them', () => {
        const local = [
            { id: 'own', actor: { id: 'a1' }, action: { type: 'create' } },
            { id: 'mention', actor: { id: 'a2' }, action: { type: 'create' }, messageHtml: 'Bo designed next to <a data-agent-id="a1">Ana</a>' },
            { id: 'prefix', actor: { id: 'a2' }, action: { type: 'create' }, messageHtml: '<a data-agent-id="a10">Al</a>' },
            { id: 'other', actor: { id: 'a3' }, action: { type: 'donate' } }
        ];
        expect(eventsInvolvingActor(local, 'a1').map(event => event.id)).toEqual(['own', 'mention']);
        expect(eventsInvolvingActor(local, '')).toEqual([]);
    });
});

describe('actor explorer view', () => {
    const parcelEvent = { id: 'llm-parcel', actor: llm, action: { type: 'create', parcelId: 'P/1' }, entity: { type: 'parcel', id: 'P/1' }, recordedAt: '2026-09-20T09:00:00Z' };

    it('opens an agreement or a design through the host opener, and only labels them on the standalone page', () => {
        const opened = [];
        const element = mountExplorer({ events: [events[2], events[4], parcelEvent], openEntity: entity => opened.push(entity) });
        const entityButtons = element.all().filter(node => node.tagName === 'BUTTON' && /^(Agreement|Design) /.test(node.textContent));
        expect(entityButtons.map(button => [button.textContent, button.title])).toEqual([
            ['Agreement bafkreigb4sp…yk2eha', MINTED], ['Design bafkreiehkrt…vygce4', DESIGN]
        ]);
        entityButtons.forEach(button => button.click());
        expect(opened).toEqual([{ type: 'agreement', id: MINTED }, { type: 'design', id: DESIGN }]);
        expect(element.all().some(node => /^Parcel /.test(node.textContent))).toBe(false);
        // The actor's card counts its agreements, not the design it published.
        expect(element.all().find(node => node.className === 'cb-option__desc').textContent).toBe('3 activities · 1 agreement · 1 transaction');

        const standalone = mountExplorer({ events: [events[2]] });
        expect(standalone.all().filter(node => /^Agreement /.test(node.textContent)).map(node => node.tagName)).toEqual(['SPAN']);
    });

    it('shows each pick of a run by the design and agreement it made', async () => {
        const loadRun = vi.fn(async () => ({
            id: 'run-1', persona: 'densifier-01', status: 'done', stage: 'minted', model: 'model-x', costs: [],
            picks: [
                { candidateId: 'c1', name: 'Courtyard infill', rationale: 'Underused.', designCid: DESIGN, agreementCid: MINTED },
                { candidateId: 'c2', rationale: 'Too small.', designCid: null, agreementCid: null }
            ]
        }));
        const element = mountExplorer({ events: [events[2]], loadRun });
        element.all().find(node => node.tagName === 'BUTTON' && node.textContent.startsWith('run ')).click();
        expect(loadRun).toHaveBeenCalledWith('run-1');
        const texts = tag => element.all().filter(node => node.tagName === tag).map(node => node.textContent);
        await vi.waitFor(() => expect(texts('SMALL')).toEqual([
            `Agreement ${MINTED} · design ${DESIGN}`, 'Agreement not proposed · design not published'
        ]));
        expect(texts('STRONG')).toEqual(expect.arrayContaining(['Courtyard infill', 'c2']));
    });
});
