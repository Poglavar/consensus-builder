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
        runs = [], events = [], docs = {}, discovery = null, oracleDiscovery = null,
        oracleEvents = [], publicRecords = null, errors = {},
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
        const oracleDiscoveryListed = oracleDiscovery?.state === 'listed';
        const latestOracle = newest(oracleEvents, event => event.eventType === 'proposal_lifecycle');
        const external = docs.oracle?.externalMarket || {};
        const externalLive = external.status === 'live_devnet' && external.proofMarket && external.proofResolution;
        const externalProof = external.proof || {};
        const externalChronology = externalProof.chronology || {};
        const externalProspective = externalChronology.classification === 'prospective';
        const mcpTools = docs.mcp?.tools || [];
        const mcpComplete = ['ugt_submit_proposal', 'ugt_pledge', 'ugt_donate', 'ugt_forecast', 'ugt_buy_verified_fact']
            .every(name => mcpTools.includes(name));
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
            oracleFacts: {
                tone: errors.oracleDiscovery ? 'error' : oracleDiscoveryListed ? 'success' : 'waiting',
                label: errors.oracleDiscovery ? 'Oracle-fact discovery unavailable'
                    : oracleDiscoveryListed ? 'Paid verified facts listed in Bazaar'
                        : x402.oracleFactsEnabled ? 'Paid fact endpoint ready; listing unverified' : 'Paid fact endpoint not configured',
                detail: errors.oracleDiscovery ? errors.oracleDiscovery
                    : oracleDiscoveryListed
                        ? `${x402.priceOracleFact || 'price unknown'} per fact · exact catalog resource verified ${oracleDiscovery.verifiedAt || ''}`.trim()
                        : x402.oracleFactsEnabled
                            ? `${x402.priceOracleFact || 'price unknown'} per fact · ${oracleDiscovery?.state || 'no catalog result'}`
                            : 'Agents can still audit the free event feed; paid recipe-bound bundles await x402 configuration.',
                endpoint: docs.endpoints?.oracleFact || null,
                discoveryUrl: docs.endpoints?.oracleFactDiscovery || null,
                listing: oracleDiscovery?.listing || null
            },
            agentTools: mcpComplete ? {
                tone: 'success', label: `${mcpTools.length} MCP tools share one action layer`,
                detail: 'Proposal, pledge, donation, forecast and verified-fact actions delegate to the same x402 and Solana adapters as deterministic agents.',
                source: docs.mcp?.source || null
            } : {
                tone: 'waiting', label: 'Agent tool package unavailable',
                detail: 'The public manifest did not report the complete shared MCP action surface.', source: null
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
                run: latestSupporter,
                transaction: latestSupporter.support?.signature || null,
                proposalId: latestSupporter.support?.proposalId || null
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
            publicRecords: publicRecords?.attestations > 0 ? {
                tone: 'success',
                label: `${publicRecords.attestations} court attestations on Solana`,
                detail: `${publicRecords.decisions} decisions · ${publicRecords.parcels} parcel facts · privacy-preserving aggregate`,
                summary: publicRecords
            } : {
                tone: errors.publicRecords ? 'error' : 'waiting',
                label: errors.publicRecords ? 'Public-record oracle unavailable' : 'Waiting for external land evidence',
                detail: errors.publicRecords || 'The court oracle publishes parcel-level SAS attestations; this app republishes only aggregate health and its public schema.',
                summary: publicRecords
            },
            externalMarket: externalLive ? {
                tone: 'success',
                label: externalProspective
                    ? 'A prospective court market settled from later evidence'
                    : 'Court evidence settled a two-sided integration proof',
                detail: externalProspective
                    ? 'The source record and attestation arrived after trading closed · 0.02 USDC claimed'
                    : 'Retrospective evidence · 0.01 USDC on each side · permissionless resolution · 0.02 USDC claimed',
                market: external.proofMarket,
                resolution: external.proofResolution,
                claim: external.proofClaim || null,
                proof: externalProof,
                prospective: externalProspective,
                chronology: externalChronology,
                nextProof: external.prospectiveProof || null
            } : {
                tone: 'waiting',
                label: 'External market proof unavailable',
                detail: 'The public agent metadata did not return a verified devnet market and resolution transaction.',
                market: null,
                resolution: null,
                claim: null,
                proof: {}
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

        const story = node(doc, 'section', null, 'hd-story');
        const storyCopy = node(doc, 'div', null, 'hd-story-copy');
        storyCopy.append(node(doc, 'span', model.externalMarket.prospective
            ? 'PROSPECTIVE MARKET · VERIFIED CHRONOLOGY'
            : 'RETROSPECTIVE INTEGRATION · LIVE DEVNET', 'hd-eyebrow'));
        storyCopy.append(node(doc, 'h2', model.externalMarket.prospective
            ? 'A possible land future became a verified outcome'
            : 'A public land fact completed the market loop'));
        storyCopy.append(node(doc, 'p', model.externalMarket.prospective
            ? 'The market and both stakes existed before the source record. After close, a public court attestation selected the result, any wallet could resolve it, and the winner claimed the pool.'
            : 'This first proof exercises recipe commitment, two-sided staking, permissionless public-record resolution and payout. Its attestation predates the market, so it proves the integration—not yet a prediction.'));
        const storyLinks = node(doc, 'div', null, 'hd-links');
        if (model.externalMarket.market) storyLinks.append(link(doc, 'Open market account ↗', `https://explorer.solana.com/address/${encodeURIComponent(model.externalMarket.market)}?cluster=devnet`));
        if (model.externalMarket.resolution) storyLinks.append(link(doc, 'Verify resolution ↗', `https://explorer.solana.com/tx/${encodeURIComponent(model.externalMarket.resolution)}?cluster=devnet`));
        if (model.externalMarket.claim) storyLinks.append(link(doc, 'Verify payout ↗', `https://explorer.solana.com/tx/${encodeURIComponent(model.externalMarket.claim)}?cluster=devnet`));
        storyCopy.append(storyLinks);
        const chronology = model.externalMarket.chronology;
        if (chronology?.timestamps) {
            const proofOrder = node(doc, 'dl', null, 'hd-proof-order');
            [
                ['Evidence first seen', chronology.timestamps.evidenceCreatedAt],
                ['Market opened', chronology.timestamps.marketCreatedAt],
                ['Trading closed', chronology.timestamps.marketClosesAt],
                ['Market resolved', chronology.timestamps.resolvedAt]
            ].forEach(([label, value]) => {
                const row = node(doc, 'div');
                row.append(node(doc, 'dt', label), node(doc, 'dd', value ? new Date(value).toLocaleString() : 'Not available'));
                proofOrder.append(row);
            });
            storyCopy.append(proofOrder, node(doc, 'p', chronology.reason, 'hd-proof-reason'));
        }
        const storyFlow = node(doc, 'ol', null, 'hd-story-flow');
        [
            ['01', 'Imagined', 'A parcel future becomes a falsifiable question.'],
            ['02', 'Proposed', 'Its recipe and outcomes are committed by hash.'],
            ['03', 'Backed', 'Capital enters both competing outcomes.'],
            ['04', 'Forecast', 'YES and NO remain visible until close.'],
            ['05', 'Attested', 'A trusted public record supplies evidence.'],
            ['06', 'Realized', 'The program derives the result and pays out.']
        ].forEach(([number, title, detail]) => {
            const item = node(doc, 'li');
            item.append(node(doc, 'span', number), node(doc, 'strong', title), node(doc, 'small', detail));
            storyFlow.append(item);
        });
        story.append(storyCopy, storyFlow);
        element.append(story);

        const cards = node(doc, 'section', null, 'hd-grid');
        addCard(cards, 'x402', model.x402, [
            { label: 'View discovery record ↗', href: model.x402.discoveryUrl || `${apiBase}/agent/discovery` },
            { label: 'Agent recipe JSON ↗', href: `${apiBase}/docs/agents.json` },
            { label: 'Quickstart ↗', href: `${apiBase}/docs/agents` }
        ]);
        addCard(cards, 'Paid oracle facts', model.oracleFacts, [
            { label: 'View fact discovery ↗', href: model.oracleFacts.discoveryUrl || `${apiBase}/agent/discovery?resource=oracle-facts` },
            model.oracle.event?.subject?.id
                ? { label: 'Request this fact ↗', href: `${apiBase}/agent/oracle/facts?subject=${encodeURIComponent(model.oracle.event.subject.id)}` }
                : {},
            { label: 'Audit free event feed ↗', href: `${apiBase}/oracle/events` }
        ]);
        addCard(cards, 'Agent tool surface', model.agentTools, [
            { label: 'MCP setup ↗', href: `${apiBase}/docs/agents` },
            { label: 'Machine manifest ↗', href: `${apiBase}/docs/agents.json` },
            model.agentTools.source
                ? { label: 'Source ↗', href: `https://github.com/Poglavar/consensus-builder/blob/colosseum-worlds-fair/${model.agentTools.source}` }
                : {}
        ]);
        addCard(cards, 'Daily proposer', model.algorithm, model.algorithm.run ? [
            { label: 'Run record ↗', href: `${apiBase}/agent/runs/${encodeURIComponent(model.algorithm.run.id)}` }
        ] : []);
        addCard(cards, 'Supporter persona', model.supporter, model.supporter.run ? [
            { label: 'Run record ↗', href: `${apiBase}/agent/runs/${encodeURIComponent(model.supporter.run.id)}` },
            model.supporter.transaction
                ? { label: 'Verify support transaction ↗', href: `https://explorer.solana.com/tx/${encodeURIComponent(model.supporter.transaction)}?cluster=devnet` }
                : {},
            model.supporter.proposalId
                ? { label: 'Open supported proposal', href: `/proposals/${encodeURIComponent(model.supporter.proposalId)}` }
                : {}
        ] : []);
        addCard(cards, 'On-chain evidence', model.evidence, [
            { label: 'Actor Explorer', href: '/actor-explorer.html' },
            model.evidence.latestTransaction ? { label: 'Latest transaction ↗', href: `https://explorer.solana.com/tx/${encodeURIComponent(model.evidence.latestTransaction)}?cluster=devnet` } : {},
            model.evidence.latestProposalId ? { label: 'Latest proposal', href: `/proposals/${encodeURIComponent(model.evidence.latestProposalId)}` } : {}
        ]);
        addCard(cards, 'Official public records', model.publicRecords, [
            { label: 'Oracle health JSON ↗', href: `${apiBase}/oracle/public-records/summary` },
            model.publicRecords.summary?.schemaUrl
                ? { label: 'Solana attestation schema ↗', href: model.publicRecords.summary.schemaUrl }
                : {}
        ]);
        addCard(cards, 'External market settlement', model.externalMarket, [
            model.externalMarket.market
                ? { label: 'Market account ↗', href: `https://explorer.solana.com/address/${encodeURIComponent(model.externalMarket.market)}?cluster=devnet` }
                : {},
            model.externalMarket.resolution
                ? { label: 'SAS resolution ↗', href: `https://explorer.solana.com/tx/${encodeURIComponent(model.externalMarket.resolution)}?cluster=devnet` }
                : {},
            model.externalMarket.claim
                ? { label: 'Winning claim ↗', href: `https://explorer.solana.com/tx/${encodeURIComponent(model.externalMarket.claim)}?cluster=devnet` }
                : {}
        ]);
        addCard(cards, 'Market resolution', model.oracle, [
            { label: 'Oracle events ↗', href: `${apiBase}/oracle/events` },
            model.oracle.event?.source?.transactionUrl
                ? { label: 'Source transaction ↗', href: model.oracle.event.source.transactionUrl }
                : {},
            model.oracle.event?.subject?.id
                ? { label: 'Resolution recipe ↗', href: `${apiBase}/oracle/recipes/${encodeURIComponent(model.oracle.recipeId)}?proposal=${encodeURIComponent(model.oracle.event.subject.id)}` }
                : {}
        ]);
        element.append(cards);

        const thesis = node(doc, 'section', null, 'hd-flow hd-thesis');
        thesis.append(node(doc, 'span', 'THE PRODUCT', 'hd-eyebrow'));
        thesis.append(node(doc, 'h2', 'The narrative can mobilize reality. It cannot declare itself true.'));
        const thesisGrid = node(doc, 'div', null, 'hd-thesis-grid');
        [
            ['1', 'Possible future', 'A human or agent expresses a falsifiable change to exact cadastral parcels.'],
            ['2', 'Causal force', 'Attention, negotiation, funding and forecasts organize around that future.'],
            ['3', 'Reality check', 'Independent public records attest what actually happened in the world.'],
            ['4', 'Settlement', 'A declared evidence recipe resolves the claim and unlocks the outcome.']
        ].forEach(([number, title, detail]) => {
            const item = node(doc, 'article');
            item.append(node(doc, 'span', number, 'hd-step-number'), node(doc, 'strong', title), node(doc, 'p', detail));
            thesisGrid.append(item);
        });
        thesis.append(thesisGrid);
        element.append(thesis);

        const flow = node(doc, 'section', null, 'hd-flow');
        flow.append(node(doc, 'h2', 'Five-minute judge path'));
        const list = node(doc, 'ol');
        [
            ['Inspect the exact live x402 Bazaar discovery record.', model.x402.discoveryUrl || `${apiBase}/agent/discovery`],
            ['Inspect the shared MCP tools an outside agent can call.', `${apiBase}/docs/agents.json`],
            ['Inspect the paid verified-fact capability and its Bazaar schema.', model.oracleFacts.discoveryUrl || `${apiBase}/agent/discovery?resource=oracle-facts`],
            ['Open the latest live actor, rationale, cost and transaction evidence.', '/actor-explorer.html'],
            ['Open a proposal in read-only Details; Counterpropose creates the editable clone.', model.evidence.latestProposalId ? `/proposals/${encodeURIComponent(model.evidence.latestProposalId)}` : '/'],
            ['Compare funded donation with a revocable soft pledge, using the same wallet UI.', model.evidence.latestProposalId ? `/proposals/${encodeURIComponent(model.evidence.latestProposalId)}` : '/'],
            ['Inspect the prediction market’s hashed oracle recipe and market account.', model.evidence.latestProposalId ? `/proposals/${encodeURIComponent(model.evidence.latestProposalId)}` : '/'],
            ['Verify the external court oracle’s aggregate health and public SAS schema.', `${apiBase}/oracle/public-records/summary`],
            ['Follow the live retrospective court-attestation proof from resolution to USDC claim.', model.externalMarket.resolution ? `https://explorer.solana.com/tx/${encodeURIComponent(model.externalMarket.resolution)}?cluster=devnet` : `${apiBase}/docs/agents.json`],
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

        const boundary = node(doc, 'section', null, 'hd-flow hd-boundary');
        boundary.append(node(doc, 'span', 'HONEST BOUNDARY', 'hd-eyebrow'));
        boundary.append(node(doc, 'h2', 'One authoritative source is live; broader geography still needs corroboration'));
        boundary.append(node(doc, 'p', 'The live external market verifies the V1 Croatian court SAS schema and trusted issuer. A V2 source-time guard and reusable Lens evaluator—with thresholds, conflict detection, and challenge windows—are code-ready. V2 still needs schema registration, attester rollout, a program upgrade, and a genuinely later court record; permit, imagery, news and OSM collectors remain future work. Everything shown here uses devnet assets with no monetary value.'));
        element.append(boundary);

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
            oracleDiscovery: `${base}/agent/discovery?resource=oracle-facts`,
            oracle: `${base}/oracle/events?limit=25`,
            publicRecords: `${base}/oracle/public-records/summary`
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
            oracleDiscovery: values.oracleDiscovery || null,
            oracleEvents: values.oracle?.events || [],
            publicRecords: values.publicRecords || null,
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
