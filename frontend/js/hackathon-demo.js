// Judge-facing status model and tiny renderer. All evidence comes from public live endpoints; the
// pure model is shared with headless tests so the page never manufactures a successful demo state.
(function attachHackathonDemo(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.HackathonDemo = api;
})(typeof window !== 'undefined' ? window : globalThis, function hackathonDemoFactory(root) {
    'use strict';

    function time(value) {
        const parsed = Date.parse(value || '');
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function newest(items, predicate = () => true) {
        return [...(items || [])].filter(predicate)
            .sort((left, right) => time(right.updatedAt || right.recordedAt || right.startedAt)
                - time(left.updatedAt || left.recordedAt || left.startedAt))[0] || null;
    }

    function ageHours(value, now) {
        const then = time(value);
        const current = time(now) || Date.now();
        return then ? Math.max(0, (current - then) / 3_600_000) : Infinity;
    }

    function buildDemoModel({
        runs = [], events = [], docs = {}, discovery = null, oracleEvents = [], errors = {},
        now = new Date().toISOString()
    } = {}) {
        const latestAlgorithm = newest(runs, run => run.controller === 'algorithm' && (run.role || 'proposer') === 'proposer');
        const latestSupporter = newest(runs, run => run.controller === 'algorithm' && run.role === 'supporter');
        const latestLlm = newest(runs, run => run.controller === 'llm');
        const proposalEvent = newest(events, event => event.entity?.type === 'proposal'
            && ['create', 'publish'].includes(event.action?.type));
        const transactionEvents = events.filter(event => event.transaction);
        const algorithmFresh = Boolean(latestAlgorithm && latestAlgorithm.status === 'done'
            && ageHours(latestAlgorithm.updatedAt || latestAlgorithm.finishedAt, now) <= 36);
        const x402 = docs.x402 || {};
        const discoveryListed = discovery?.state === 'listed';
        const latestOracle = newest(oracleEvents, event => event.eventType === 'proposal_lifecycle');
        return {
            generatedAt: now,
            x402: {
                tone: errors.discovery ? 'error' : discoveryListed ? 'success' : 'waiting',
                label: errors.discovery ? 'Catalog verification unavailable'
                    : discoveryListed ? 'Listed in the hosted x402 Bazaar'
                        : x402.enabled ? 'Hosted facilitator configured; listing unverified' : 'Configuration unavailable',
                detail: errors.discovery ? errors.discovery
                    : discoveryListed
                        ? `${x402.priceProposal || 'price unknown'} per proposal · exact catalog resource verified ${discovery.verifiedAt || ''}`.trim()
                        : x402.enabled
                            ? `${x402.priceProposal || 'price unknown'} per proposal · ${discovery?.state || 'no catalog result'}`
                            : 'The public recipe did not report an enabled x402 endpoint.',
                facilitatorUrl: x402.facilitatorUrl || null,
                submitUrl: docs.endpoints?.submit || null,
                discoveryUrl: docs.endpoints?.discovery || null,
                listing: discovery?.listing || null
            },
            algorithm: latestAlgorithm ? {
                tone: algorithmFresh ? 'success' : 'waiting',
                label: algorithmFresh ? 'Fresh deterministic run completed' : 'Algorithmic run exists, but is not fresh',
                detail: `${latestAlgorithm.persona} · ${latestAlgorithm.stage || latestAlgorithm.status} · $${Number(latestAlgorithm.modelCostUsd || 0).toFixed(4)} model spend`,
                run: latestAlgorithm
            } : {
                tone: 'waiting', label: 'Waiting for first deterministic scheduled run',
                detail: 'This card updates from the checkpoint ledger; an older LLM run is not relabelled as algorithmic.', run: null
            },
            supporter: latestSupporter ? {
                tone: latestSupporter.status === 'done' ? 'success' : latestSupporter.status === 'failed' ? 'error' : 'waiting',
                label: latestSupporter.status === 'done' ? 'Supporter persona acted on-chain' : `Supporter run ${latestSupporter.status}`,
                detail: latestSupporter.support
                    ? `${latestSupporter.persona} · ${latestSupporter.support.type} · proposal ${latestSupporter.support.proposalId}`
                    : `${latestSupporter.persona} · ${latestSupporter.outcome || latestSupporter.stage || 'pending'}`,
                run: latestSupporter
            } : {
                tone: 'waiting', label: 'Supporter persona ready, first run pending',
                detail: 'The deterministic supporter will pledge to an active minted proposal by another actor.', run: null
            },
            evidence: {
                tone: transactionEvents.length ? 'success' : 'waiting',
                label: `${transactionEvents.length} transaction-backed activit${transactionEvents.length === 1 ? 'y' : 'ies'} loaded`,
                detail: proposalEvent
                    ? `Latest proposal evidence: ${proposalEvent.entity.id}`
                    : 'No proposal event was returned by the live activity endpoint.',
                latestProposalId: proposalEvent?.entity?.id || null,
                latestTransaction: newest(transactionEvents)?.transaction || null
            },
            programs: {
                market: docs.market?.programId || null,
                support: docs.proposalSupport?.programId || null
            },
            oracle: latestOracle ? {
                tone: 'success',
                label: `${latestOracle.outcome === 'executed' ? 'Executed' : 'Cancelled'} proposal event attested`,
                detail: `${latestOracle.subject?.id || 'proposal'} · observed ${latestOracle.observedAt || 'on Solana'}`,
                event: latestOracle,
                recipeId: docs.oracle?.recipeId || 'proposal-lifecycle-v1'
            } : {
                tone: errors.oracle ? 'error' : 'waiting',
                label: errors.oracle ? 'Land-event feed unavailable' : 'Waiting for a terminal proposal event',
                detail: errors.oracle || 'The first oracle records Executed/Cancelled proposal state with source hash, transaction and program attester.',
                event: null,
                recipeId: docs.oracle?.recipeId || 'proposal-lifecycle-v1'
            },
            errors,
            latestLlm
        };
    }

    function backendBase() {
        const configured = root?.document?.querySelector?.('meta[name="consensus-api-base"]')?.content;
        if (configured) return String(configured).replace(/\/$/, '');
        const host = root?.location?.hostname || '';
        return host === 'localhost' || host === '127.0.0.1' ? 'http://localhost:3000' : 'https://api.urbangametheory.xyz';
    }

    function node(doc, tag, value, className = '') {
        const item = doc.createElement(tag);
        if (className) item.className = className;
        if (value !== undefined && value !== null) item.textContent = value;
        return item;
    }

    function link(doc, label, href, className = '') {
        const item = node(doc, 'a', label, className);
        item.href = href;
        if (/^https?:/.test(href)) { item.target = '_blank'; item.rel = 'noopener'; }
        return item;
    }

    function addCard(container, title, card, links = []) {
        const doc = container.ownerDocument;
        const section = node(doc, 'article', null, `hd-card is-${card.tone}`);
        const head = node(doc, 'div', null, 'hd-card-head');
        head.append(node(doc, 'span', title, 'hd-eyebrow'), node(doc, 'span', card.tone === 'success' ? 'LIVE' : card.tone === 'error' ? 'ERROR' : 'PENDING', 'hd-pill'));
        section.append(head, node(doc, 'h2', card.label), node(doc, 'p', card.detail, 'hd-muted'));
        const actions = node(doc, 'div', null, 'hd-links');
        links.filter(item => item.href).forEach(item => actions.append(link(doc, item.label, item.href)));
        if (actions.childElementCount) section.append(actions);
        container.append(section);
    }

    function render(element, model, { apiBase = backendBase() } = {}) {
        const doc = element.ownerDocument;
        element.replaceChildren();
        const cards = node(doc, 'section', null, 'hd-grid');
        addCard(cards, 'x402', model.x402, [
            { label: 'View discovery record ↗', href: model.x402.discoveryUrl || `${apiBase}/agent/discovery` },
            { label: 'Agent recipe JSON ↗', href: `${apiBase}/docs/agents.json` },
            { label: 'Quickstart ↗', href: `${apiBase}/docs/agents` }
        ]);
        addCard(cards, 'Daily proposer', model.algorithm, model.algorithm.run ? [
            { label: 'Run record ↗', href: `${apiBase}/agent/runs/${encodeURIComponent(model.algorithm.run.id)}` }
        ] : []);
        addCard(cards, 'Supporter persona', model.supporter, model.supporter.run ? [
            { label: 'Run record ↗', href: `${apiBase}/agent/runs/${encodeURIComponent(model.supporter.run.id)}` }
        ] : []);
        addCard(cards, 'On-chain evidence', model.evidence, [
            { label: 'Actor Explorer', href: '/actor-explorer.html' },
            model.evidence.latestTransaction ? { label: 'Latest transaction ↗', href: `https://explorer.solana.com/tx/${encodeURIComponent(model.evidence.latestTransaction)}?cluster=devnet` } : {},
            model.evidence.latestProposalId ? { label: 'Latest proposal', href: `/proposals/${encodeURIComponent(model.evidence.latestProposalId)}` } : {}
        ]);
        addCard(cards, 'Land-event oracle', model.oracle, [
            { label: 'Oracle events ↗', href: `${apiBase}/oracle/events` },
            model.oracle.event?.source?.transactionUrl
                ? { label: 'Source transaction ↗', href: model.oracle.event.source.transactionUrl }
                : {},
            model.oracle.event?.subject?.id
                ? { label: 'Resolution recipe ↗', href: `${apiBase}/oracle/recipes/${encodeURIComponent(model.oracle.recipeId)}?proposal=${encodeURIComponent(model.oracle.event.subject.id)}` }
                : {}
        ]);
        element.append(cards);

        const flow = node(doc, 'section', null, 'hd-flow');
        flow.append(node(doc, 'h2', 'Five-minute judge path'));
        const list = node(doc, 'ol');
        [
            ['Inspect the exact live x402 Bazaar discovery record.', model.x402.discoveryUrl || `${apiBase}/agent/discovery`],
            ['Open the latest live actor, rationale, cost and transaction evidence.', '/actor-explorer.html'],
            ['Open a proposal in read-only Details; Counterpropose creates the editable clone.', model.evidence.latestProposalId ? `/proposals/${encodeURIComponent(model.evidence.latestProposalId)}` : '/'],
            ['Compare funded donation with a revocable soft pledge, using the same wallet UI.', model.evidence.latestProposalId ? `/proposals/${encodeURIComponent(model.evidence.latestProposalId)}` : '/'],
            ['Inspect the prediction market’s hashed oracle recipe and market account.', model.evidence.latestProposalId ? `/proposals/${encodeURIComponent(model.evidence.latestProposalId)}` : '/'],
            ['Open a source-hashed proposal lifecycle event and its Solana transaction.', `${apiBase}/oracle/events`]
        ].forEach(([label, href]) => {
            const item = node(doc, 'li'); item.append(link(doc, label, href)); list.append(item);
        });
        flow.append(list);
        const programs = node(doc, 'div', null, 'hd-programs');
        if (model.programs.market) programs.append(link(doc, `Market program ${model.programs.market}`, `https://explorer.solana.com/address/${model.programs.market}?cluster=devnet`));
        if (model.programs.support) programs.append(link(doc, `Funding program ${model.programs.support}`, `https://explorer.solana.com/address/${model.programs.support}?cluster=devnet`));
        flow.append(programs);
        element.append(flow);

        const readiness = node(doc, 'section', null, 'hd-flow hd-readiness');
        readiness.append(node(doc, 'h2', 'Demo readiness and recovery'));
        const readinessGrid = node(doc, 'div', null, 'hd-readiness-grid');
        const wallet = node(doc, 'article');
        wallet.append(node(doc, 'strong', 'Wallet checklist'), node(doc, 'p', 'Use Solana devnet. SOL pays market/support transaction fees; Circle devnet USDC pays x402, donations and stakes.'));
        const faucets = node(doc, 'div', null, 'hd-links hd-static-links');
        faucets.append(link(doc, 'Solana faucet ↗', 'https://faucet.solana.com'), link(doc, 'Circle USDC faucet ↗', 'https://faucet.circle.com'));
        wallet.append(faucets);
        const reset = node(doc, 'article');
        reset.append(node(doc, 'strong', 'Resettable fallback'), node(doc, 'p', 'Open the map, expand Game, enable game mode, then choose New Game. This clears only browser-local simulation state; public records and devnet transactions remain untouched.'));
        reset.append(link(doc, 'Open map simulation', '/?reduceMotion=1'));
        const recover = node(doc, 'article');
        recover.append(node(doc, 'strong', 'If a live service is slow'), node(doc, 'p', 'Pending and error cards remain explicit. Retry the evidence reads; the simulation fallback still demonstrates the shared actor/action UI.'));
        const retry = node(doc, 'button', 'Retry live evidence', 'hd-retry');
        retry.type = 'button'; retry.addEventListener('click', () => boot()); recover.append(retry);
        readinessGrid.append(wallet, reset, recover);
        readiness.append(readinessGrid);
        const errorValues = Object.entries(model.errors || {});
        if (errorValues.length) {
            const list = node(doc, 'ul', null, 'hd-errors');
            errorValues.forEach(([source, message]) => list.append(node(doc, 'li', `${source}: ${message}`)));
            readiness.append(list);
        }
        element.append(readiness);
    }

    async function fetchJson(url) {
        const response = await fetch(url, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`${url} returned ${response.status}`);
        return response.json();
    }

    async function fetchEvidence(base) {
        const requests = {
            runs: `${base}/agent/runs?limit=50`,
            activity: `${base}/agent/activity?limit=150`,
            docs: `${base}/docs/agents.json`,
            discovery: `${base}/agent/discovery`,
            oracle: `${base}/oracle/events?limit=25`
        };
        const entries = Object.entries(requests);
        const results = await Promise.allSettled(entries.map(([, url]) => fetchJson(url)));
        const values = {};
        const errors = {};
        results.forEach((result, index) => {
            const key = entries[index][0];
            if (result.status === 'fulfilled') values[key] = result.value;
            else errors[key] = result.reason?.message || String(result.reason);
        });
        return { values, errors };
    }

    async function boot() {
        const element = root?.document?.getElementById('hackathon-demo');
        if (!element) return;
        const base = backendBase();
        element.textContent = 'Loading public run, activity, payment and oracle evidence…';
        const { values, errors } = await fetchEvidence(base);
        render(element, buildDemoModel({
            runs: values.runs?.runs || [],
            events: values.activity?.events || [],
            docs: values.docs || {},
            discovery: values.discovery || null,
            oracleEvents: values.oracle?.events || [],
            errors
        }), { apiBase: base });
    }

    if (root?.document) {
        const start = () => boot().catch(error => {
            const element = root.document.getElementById('hackathon-demo');
            if (element) element.textContent = `Could not load live hackathon evidence: ${error.message}`;
        });
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start);
        else start();
    }

    return { ageHours, backendBase, buildDemoModel, fetchEvidence, newest, render };
});
