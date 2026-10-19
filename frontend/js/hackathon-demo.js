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

    // Money- and consent-moving actions a judge verifies on Explorer, in lifecycle order. Only activity
    // entries that carry a transaction signature count; anything missing simply is not listed.
    const CASE_ACTIONS = [
        { type: 'certifyParcel', label: 'Ownership certificate' },
        { type: 'accept', label: 'Acceptance' },
        { type: 'resolve', label: 'Market resolution' },
        { type: 'releaseDonations', label: 'Donation release' },
        { type: 'fulfillPledge', label: 'Pledge fulfilment' },
        { type: 'claim', side: 'yes', label: 'YES claim' }
    ];

    function explorerTx(signature) {
        return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
    }

    function caseTransactions(caseRecord) {
        const activity = Array.isArray(caseRecord?.activity) ? caseRecord.activity : [];
        return CASE_ACTIONS.flatMap(spec => activity
            .filter(event => event?.ok !== false && event?.transaction && event.action?.type === spec.type
                && (!spec.side || event.action?.side === spec.side))
            .map(event => ({
                type: spec.type,
                label: event.action?.parcelId ? `${spec.label} ${event.action.parcelId}` : spec.label,
                signature: event.transaction,
                url: explorerTx(event.transaction)
            })));
    }

    // One card model for any aggregate case (cancelled golden case, executed YES counterpart). Success is
    // earned only by the server's own `state: complete`; a missing record stays pending/unavailable.
    function caseCardModel(caseRecord, { error = null, name = 'Case', missing = 'No aggregate case record was returned.' } = {}) {
        if (!caseRecord) return {
            tone: error ? 'error' : 'waiting',
            state: error ? 'unavailable' : 'pending',
            label: error ? `${name} unavailable` : `${name} pending`,
            detail: error || missing,
            lifecycle: null, marketOutcome: null, transactions: [], ownerCaveat: false,
            case: null
        };
        const forecast = caseRecord.branches?.forecast;
        const transactions = caseTransactions(caseRecord);
        const actorOf = type => new Set((caseRecord.activity || [])
            .filter(event => event?.action?.type === type && event.transaction).map(event => event.actor?.id).filter(Boolean));
        const certifiers = actorOf('certifyParcel');
        const acceptors = actorOf('accept');
        return {
            tone: caseRecord.state === 'complete' ? 'success' : 'waiting',
            state: caseRecord.state || 'unknown',
            label: caseRecord.proposal?.name || caseRecord.id || name,
            detail: `${caseRecord.parcelSet?.parcelCount || 0} real cadastral parcel${caseRecord.parcelSet?.parcelCount === 1 ? '' : 's'} · ${caseRecord.progress?.complete || 0}/${caseRecord.progress?.total || 0} independently verified stages`,
            lifecycle: caseRecord.proposal?.lifecycleStatus || null,
            marketOutcome: forecast?.resolved ? (forecast.outcome || 'Resolved') : (forecast?.exists ? 'Unresolved' : null),
            transactions,
            // The ownership certificates were minted to the same agent that accepted: mechanics, not owner consent.
            ownerCaveat: acceptors.size > 0 && [...acceptors].every(id => certifiers.has(id)),
            case: caseRecord
        };
    }

    function buildDemoModel({
        runs = [], events = [], docs = {}, discovery = null, oracleDiscovery = null,
        oracleEvents = [], publicRecords = null, prospectiveMarket = null, proofManifest = null, canonicalCase = null, executedCase = null, errors = {},
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
        const independentX402 = proofManifest?.publicProof?.independentX402 || null;
        const discoveryListed = discovery?.state === 'listed';
        const oracleDiscoveryListed = oracleDiscovery?.state === 'listed';
        const latestOracle = newest(oracleEvents, event => event.eventType === 'proposal_lifecycle');
        const external = docs.oracle?.externalMarket || {};
        const externalLive = external.status === 'live_devnet' && external.proofMarket && external.proofResolution;
        const externalProof = external.proof || {};
        const externalChronology = externalProof.chronology || {};
        const externalProspective = externalChronology.classification === 'prospective';
        const declaredProspective = external.prospectiveProof || {};
        const prospective = prospectiveMarket?.market ? prospectiveMarket : declaredProspective.market ? {
            state: time(declaredProspective.closesAt) > time(now) ? 'open' : 'checking_evidence',
            market: declaredProspective.market,
            marketUrl: `https://explorer.solana.com/address/${declaredProspective.market}?cluster=devnet`,
            recipeHash: declaredProspective.recipeHash || null,
            closesAt: declaredProspective.closesAt,
            stakes: { yes: 0.01, no: 0.01, pool: 0.02 },
            resolver: { cadence: 'hourly at minute 45', lastRun: null }
        } : null;
        const prospectiveSettlement = prospective?.settlement || null;
        const prospectiveSettled = prospective?.state === 'settled'
            && prospectiveSettlement?.chronology?.classification === 'prospective';
        const prospectiveError = errors.prospective;
        const mcpTools = docs.mcp?.tools || [];
        const mcpComplete = ['ugt_submit_proposal', 'ugt_pledge', 'ugt_donate', 'ugt_forecast', 'ugt_buy_verified_fact']
            .every(name => mcpTools.includes(name));
        const proofChecks = [
            {
                label: 'Proposal capability',
                status: errors.discovery ? 'error' : discoveryListed ? 'success' : 'waiting'
            },
            {
                label: 'Agent proposal on-chain',
                status: algorithmFresh && Boolean(proposalEvent?.transaction) ? 'success' : 'waiting'
            },
            {
                label: 'Support on-chain',
                status: latestSupporter?.status === 'done' && Boolean(latestSupporter.support?.signature) ? 'success' : 'waiting'
            },
            {
                label: 'Court evidence',
                status: publicRecords?.v2?.attestations > 0 ? 'success' : errors.publicRecords ? 'error' : 'waiting'
            },
            {
                label: 'Two-sided market',
                status: prospective?.market ? 'success' : prospectiveError ? 'error' : 'waiting'
            },
            {
                label: 'Fact discovery',
                status: errors.oracleDiscovery ? 'error' : oracleDiscoveryListed ? 'success' : 'waiting'
            }
        ];

        return {
            proofChecks,
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
                    : oracleDiscoveryListed && independentX402?.transaction ? 'Independent agent discovered, paid and verified a fact'
                        : oracleDiscoveryListed ? 'Paid verified facts listed in Bazaar'
                        : x402.oracleFactsEnabled ? 'Paid fact live; Bazaar indexing pending' : 'Paid fact endpoint not configured',
                detail: errors.oracleDiscovery ? errors.oracleDiscovery
                    : oracleDiscoveryListed
                        ? `${x402.priceOracleFact || 'price unknown'} per fact · exact catalog resource verified ${oracleDiscovery.verifiedAt || ''}${independentX402?.transaction ? ' · second project wallet settled through a clean-room client' : ''}`.trim()
                        : x402.oracleFactsEnabled
                            ? `${x402.priceOracleFact || 'price unknown'} per fact · ${oracleDiscovery?.state || 'no catalog result'}`
                            : 'Agents can still audit the free event feed; paid recipe-bound bundles await x402 configuration.',
                endpoint: docs.endpoints?.oracleFact || null,
                discoveryUrl: docs.endpoints?.oracleFactDiscovery || null,
                listing: oracleDiscovery?.listing || null,
                independentProof: independentX402
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
                detail: `${publicRecords.decisions} decisions · ${publicRecords.parcels} parcel facts · ${publicRecords.v2?.attestations || 0} source-timed V2 · privacy-preserving aggregate`,
                summary: publicRecords
            } : {
                tone: errors.publicRecords ? 'error' : 'waiting',
                label: errors.publicRecords ? 'Public-record oracle unavailable' : 'Waiting for external land evidence',
                detail: errors.publicRecords || 'The court oracle publishes parcel-level SAS attestations; this app republishes only aggregate health and its public schema.',
                summary: publicRecords
            },
            prospectiveMarket: prospective ? {
                tone: prospective.state === 'resolver_error' ? 'error' : 'success',
                state: prospective.state || 'unknown',
                label: prospective.state === 'settled' ? 'Prospective market settled from later evidence'
                    : prospective.state === 'awaiting_evidence' ? 'Trading closed; waiting for matching later evidence'
                        : prospective.state === 'checking_evidence' ? 'Trading closed; resolver is checking public records'
                            : prospective.state === 'open' ? 'Two-sided prospective court market is open'
                                : 'Prospective market status available',
                detail: prospective.state === 'settled'
                    ? 'The market, both stakes and committed recipe predated the resolving source record.'
                    : `${prospective.stakes?.pool ?? 0.02} devnet USDC across YES and NO · resolver ${prospective.resolver?.cadence || 'runs on a public schedule'} · only post-close source-timestamped evidence qualifies`,
                market: prospective.market,
                marketUrl: prospective.marketUrl,
                recipeHash: prospective.recipeHash || null,
                closesAt: prospective.closesAt || null,
                stakes: prospective.stakes || null,
                resolver: prospective.resolver || null,
                settlement: prospectiveSettlement
            } : {
                tone: prospectiveError ? 'error' : 'waiting', state: 'unavailable',
                label: prospectiveError ? 'Prospective market status unavailable' : 'Prospective market not declared',
                detail: prospectiveError || 'No public prospective-market evidence was returned.',
                market: null, marketUrl: null, recipeHash: null, closesAt: null, stakes: null, resolver: null
            },
            externalMarket: prospectiveSettled ? {
                tone: 'success',
                label: 'A prospective court market settled from later evidence',
                detail: 'The source record and attestation arrived after trading closed · the winning devnet USDC position was claimed',
                market: prospective.market,
                resolution: prospectiveSettlement.transactions?.resolution || null,
                claim: prospectiveSettlement.transactions?.claim || null,
                evidence: prospectiveSettlement.evidence || null,
                proof: prospectiveSettlement,
                prospective: true,
                chronology: prospectiveSettlement.chronology,
                nextProof: null
            } : externalLive ? {
                tone: 'success',
                label: externalProspective
                    ? 'A prospective court market settled from later evidence'
                    : 'Court evidence settled a two-sided integration proof',
                detail: externalProspective
                    ? 'The source record and attestation arrived after trading closed · 0.02 USDC claimed'
                    : external.prospectiveProof?.market
                        ? `Retrospective payout proven · prospective V2 market open until ${new Date(external.prospectiveProof.closesAt).toLocaleString()} · awaiting later evidence`
                        : 'Retrospective payout proven · V2 schema and on-chain chronology guard now live · awaiting the first post-close court record',
                market: external.proofMarket,
                resolution: external.proofResolution,
                claim: external.proofClaim || null,
                proof: externalProof,
                prospective: externalProspective,
                chronology: externalChronology,
                evidence: externalProof.evidence || null,
                nextProof: external.prospectiveProof || null
            } : {
                tone: 'waiting',
                label: 'External market proof unavailable',
                detail: 'The public agent metadata did not return a verified devnet market and resolution transaction.',
                market: null,
                resolution: null,
                claim: null,
                evidence: null,
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
            proofManifest,
            canonicalCase: caseCardModel(canonicalCase, { error: errors.canonicalCase, name: 'Canonical case' }),
            executedCase: caseCardModel(executedCase, {
                error: errors.executedCase,
                name: 'Executed case',
                missing: proofManifest?.publicProof?.executedCase
                    ? 'No aggregate case record was returned.'
                    : 'The proof manifest does not declare an executed case yet.'
            }),
            latestLlm
        };
    }

    function backendBase() {
        const configured = root?.document?.querySelector?.('meta[name="consensus-api-base"]')?.content;
        if (configured) return String(configured).replace(/\/$/, '');
        const host = root?.location?.hostname || '';
        const local = host === 'localhost' || host === '127.0.0.1';
        // dev.sh starts each worktree's backend on its own port and passes it as ?backend=; localhost only.
        const override = local ? new URLSearchParams(root?.location?.search || '').get('backend') : null;
        if (override && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(override)) return override;
        return local ? 'http://localhost:3000' : 'https://api.urbangametheory.xyz';
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
        if (/^https?:/.test(href)) { item.target = '_blank'; item.rel = 'noopener noreferrer'; item.classList.add('is-external'); }
        return item;
    }

    function explorerAddress(address) {
        return `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet`;
    }

    function when(value) {
        return value ? new Date(value).toLocaleString() : 'Not available';
    }

    function section(doc, title, intro = '', className = '') {
        const item = node(doc, 'section', null, `hd-section ${className}`.trim());
        item.append(node(doc, 'h2', title));
        if (intro) item.append(node(doc, 'p', intro, 'hd-muted'));
        return item;
    }

    function factList(doc, rows) {
        const list = node(doc, 'dl', null, 'hd-facts');
        rows.forEach(([label, value]) => {
            const row = node(doc, 'div');
            row.append(node(doc, 'dt', label), node(doc, 'dd', value));
            list.append(row);
        });
        return list;
    }

    function linkRow(doc, links) {
        const row = node(doc, 'div', null, 'hd-links');
        links.filter(item => item?.href).forEach(item => row.append(link(doc, item.label, item.href)));
        return row;
    }

    const STATUS_WORD = { success: 'Live', error: 'Error', waiting: 'Pending' };

    // One proposal followed through every stage: outcome, a compact stage track, two ways in, and the
    // signed transactions folded away for whoever wants to verify them.
    function caseCard(doc, card, fallbackTitle) {
        const article = node(doc, 'article', null, `hd-case is-${card.tone}`);
        const head = node(doc, 'div', null, 'hd-case__head');
        head.append(
            node(doc, 'h3', card.case ? card.label : fallbackTitle),
            node(doc, 'span', card.marketOutcome ? `Resolved ${card.marketOutcome}` : String(card.state || 'pending').replaceAll('_', ' '), 'hd-pill')
        );
        article.append(head);
        article.append(node(doc, 'p', card.case ? `${card.lifecycle || 'No lifecycle recorded'} · ${card.detail}` : card.detail, 'hd-muted'));
        if (card.case?.stages?.length) {
            const stages = node(doc, 'ol', null, 'hd-stages');
            card.case.stages.forEach(stage => {
                const item = node(doc, 'li', stage.label, `is-${stage.state || 'pending'}`);
                if (stage.detail) item.title = stage.detail;
                stages.append(item);
            });
            article.append(stages);
        }
        if (card.case) {
            article.append(linkRow(doc, [
                { label: 'Open on the map', href: card.case.links?.map },
                // Same `?activity=proposal:<id>` deep link the map explorer parses (AgentActionEngine.parseActivityLink).
                { label: 'Every action in the explorer', href: card.case.id ? `/?activity=${encodeURIComponent(`proposal:${card.case.id}`)}` : null }
            ]));
            const more = node(doc, 'details', null, 'hd-fold');
            more.append(node(doc, 'summary', card.transactions.length ? `Transactions (${card.transactions.length})` : 'Raw record'));
            more.append(linkRow(doc, [
                ...card.transactions.map(tx => ({ label: tx.label, href: tx.url })),
                { label: 'Case record (JSON)', href: card.case.links?.self }
            ]));
            article.append(more);
        }
        if (card.ownerCaveat) article.append(node(doc, 'p', 'The agent that accepted also holds the devnet ownership certificates, so this shows the mechanics and the payout, not a real owner’s consent.', 'hd-note'));
        return article;
    }

    function statusRow(doc, name, card, primary) {
        const row = node(doc, 'li', null, `hd-status__row is-${card.tone}`);
        const word = node(doc, 'span', STATUS_WORD[card.tone] || 'Pending', 'hd-status__word');
        const copy = node(doc, 'div', null, 'hd-status__copy');
        copy.append(node(doc, 'strong', name), node(doc, 'span', card.label));
        if (card.detail) copy.title = card.detail;
        row.append(word, copy);
        if (primary?.href) row.append(link(doc, primary.label, primary.href, 'hd-status__link'));
        return row;
    }

    function render(element, model, { apiBase = backendBase() } = {}) {
        const doc = element.ownerDocument;
        element.replaceChildren();

        // How it works: the one loop, said once.
        const how = section(doc, 'How it works');
        const steps = node(doc, 'ol', null, 'hd-steps');
        [
            ['Propose', 'A person or an agent proposes a change to real cadastral parcels.'],
            ['Back', 'Supporters donate or pledge devnet USDC to the proposal.'],
            ['Forecast', 'Anyone stakes YES or NO on whether it will happen.'],
            ['Settle', 'A public record says what happened. The market resolves and pays out.']
        ].forEach(([title, text]) => {
            const item = node(doc, 'li');
            item.append(node(doc, 'strong', title), node(doc, 'span', text));
            steps.append(item);
        });
        how.append(steps);
        element.append(how);

        // The two proven proposals, NO and YES, side by side.
        const cases = section(doc, 'Two proposals, followed end to end',
            'One was cancelled and its market resolved NO. The other was carried out and resolved YES. Every stage is recorded on Solana devnet.');
        cases.id = 'judge-path';
        const caseGrid = node(doc, 'div', null, 'hd-cases');
        caseGrid.append(caseCard(doc, model.canonicalCase, 'Cancelled case'), caseCard(doc, model.executedCase, 'Executed case'));
        cases.append(caseGrid);
        element.append(cases);

        // Everything that runs on its own, one line each; the detail sits in the row's tooltip.
        const running = section(doc, 'Running now', 'Read live from the public API. Anything not yet proven says Pending.');
        const errorValues = Object.entries(model.errors || {});
        if (errorValues.length) {
            const errors = node(doc, 'ul', null, 'hd-errors');
            errorValues.forEach(([source, message]) => errors.append(node(doc, 'li', `${source}: ${message}`)));
            running.append(errors);
        }
        const live = model.prospectiveMarket;
        const rows = node(doc, 'ul', null, 'hd-status');
        rows.append(
            statusRow(doc, 'Prospective market', live, { label: 'Market', href: live.marketUrl }),
            statusRow(doc, 'Court records oracle', model.publicRecords, { label: 'Schema', href: model.publicRecords.summary?.schemaUrl || `${apiBase}/oracle/public-records/summary` }),
            statusRow(doc, 'Paid facts for agents', model.oracleFacts, model.oracleFacts.independentProof?.transactionUrl
                ? { label: 'Payment', href: model.oracleFacts.independentProof.transactionUrl }
                : { label: 'Discovery', href: model.oracleFacts.discoveryUrl || `${apiBase}/agent/discovery?resource=oracle-facts` }),
            statusRow(doc, 'Paid proposals for agents', model.x402, { label: 'Discovery', href: model.x402.discoveryUrl || `${apiBase}/agent/discovery` }),
            statusRow(doc, 'Agent tools (MCP)', model.agentTools, { label: 'Setup', href: `${apiBase}/docs/agents` }),
            statusRow(doc, 'Daily proposer agent', model.algorithm, model.algorithm.run ? { label: 'Run', href: `${apiBase}/agent/runs/${encodeURIComponent(model.algorithm.run.id)}` } : null),
            statusRow(doc, 'Supporter agent', model.supporter, model.supporter.transaction ? { label: 'Transaction', href: explorerTx(model.supporter.transaction) } : null),
            statusRow(doc, 'Lifecycle oracle', model.oracle, { label: 'Events', href: `${apiBase}/oracle/events` }),
            statusRow(doc, 'On-chain activity', model.evidence, { label: 'Explorer', href: '/actor-explorer.html' })
        );
        running.append(rows);
        element.append(running);

        // Reviewer detail, folded: the live market's facts, the retrospective proof's chronology,
        // program ids and machine-readable endpoints.
        const more = node(doc, 'details', null, 'hd-section hd-fold hd-fold--section');
        more.append(node(doc, 'summary', 'Evidence details'));
        more.append(node(doc, 'h3', live.label));
        more.append(node(doc, 'p', live.detail, 'hd-muted'));
        const liveRows = [
            ['Market', live.market || 'Unavailable'],
            ['Pool', live.stakes ? `${live.stakes.pool} devnet USDC` : 'Unavailable'],
            ['Trading closed', live.closesAt ? when(live.closesAt) : 'Unavailable'],
            ['Recipe', live.recipeHash || 'Unavailable'],
            ['Last resolver check', live.resolver?.lastRun?.endedAt ? when(live.resolver.lastRun.endedAt) : 'Awaiting public run ledger']
        ];
        if (live.settlement?.chronology?.timestamps) liveRows.push(
            ['Source publication', when(live.settlement.chronology.timestamps.sourceObservedAt)],
            ['Evidence first seen', when(live.settlement.chronology.timestamps.evidenceCreatedAt)],
            ['Payout claimed', when(live.settlement.chronology.timestamps.claimedAt)]
        );
        more.append(factList(doc, liveRows), linkRow(doc, [
            { label: 'Resolving evidence', href: live.settlement?.evidence?.address ? explorerAddress(live.settlement.evidence.address) : null },
            { label: 'Resolution', href: live.settlement?.transactions?.resolution ? explorerTx(live.settlement.transactions.resolution) : null },
            { label: 'Payout', href: live.settlement?.transactions?.claim ? explorerTx(live.settlement.transactions.claim) : null },
            { label: 'Resolver status', href: `${apiBase}/oracle/markets/prospective/status` },
            { label: 'Proof manifest', href: `${apiBase}/hackathon/proof.json` }
        ]));

        const external = model.externalMarket;
        more.append(node(doc, 'h3', external.label));
        more.append(node(doc, 'p', external.prospective
            ? 'The market and both stakes existed before the source record. After close, a court attestation chose the result, any wallet could resolve it, and the winner claimed the pool.'
            : 'This proof runs the whole loop: committed recipe, stakes on both sides, resolution from a public record, payout. The record predates the market, so it proves the integration, not a prediction.', 'hd-muted'));
        const chronology = external.chronology?.timestamps;
        if (chronology) more.append(factList(doc, [
            ['Market opened', when(chronology.marketCreatedAt)],
            ['YES stake', when(chronology.yesStakeAt)],
            ['NO stake', when(chronology.noStakeAt)],
            ['Trading closed', when(chronology.marketClosesAt)],
            ['Source publication', when(chronology.sourceObservedAt)],
            ['Evidence first seen', when(chronology.evidenceCreatedAt)],
            ['Market resolved', when(chronology.resolvedAt)],
            ['Payout claimed', when(chronology.claimedAt)]
        ]));
        more.append(linkRow(doc, [
            { label: 'Market account', href: external.market ? explorerAddress(external.market) : null },
            { label: 'Evidence', href: external.evidence?.address ? explorerAddress(external.evidence.address) : null },
            { label: 'Resolution', href: external.resolution ? explorerTx(external.resolution) : null },
            { label: 'Payout', href: external.claim ? explorerTx(external.claim) : null }
        ]));

        more.append(node(doc, 'h3', 'Programs and endpoints'));
        more.append(factList(doc, [
            ['Market program', model.programs.market || 'Unavailable'],
            ['Funding program', model.programs.support || 'Unavailable']
        ]));
        more.append(linkRow(doc, [
            { label: 'Market program', href: model.programs.market ? explorerAddress(model.programs.market) : null },
            { label: 'Funding program', href: model.programs.support ? explorerAddress(model.programs.support) : null },
            { label: 'Agent recipe (JSON)', href: `${apiBase}/docs/agents.json` },
            { label: 'Oracle health (JSON)', href: `${apiBase}/oracle/public-records/summary` },
            { label: 'Latest lifecycle fact', href: model.oracle.event?.subject?.id ? `${apiBase}/agent/oracle/facts?subject=${encodeURIComponent(model.oracle.event.subject.id)}` : null },
            { label: 'Source code', href: model.agentTools.source ? `https://github.com/Poglavar/consensus-builder/blob/colosseum-worlds-fair/${model.agentTools.source}` : null }
        ]));
        element.append(more);

        const limits = section(doc, 'Limits', '', 'hd-limits');
        const limitList = node(doc, 'ul');
        [
            'Everything runs on Solana devnet with test USDC that has no value.',
            'One authoritative source is live: Croatian court records. Permit, imagery, news and OpenStreetMap collectors are future work.',
            'The prospective market settles only from a record published after it closed, so it can wait a long time.'
        ].forEach(text => limitList.append(node(doc, 'li', text)));
        limits.append(limitList);
        element.append(limits);

        const tryIt = node(doc, 'details', null, 'hd-section hd-fold hd-fold--section');
        tryIt.append(node(doc, 'summary', 'Try it yourself'));
        tryIt.append(node(doc, 'p', 'Switch your wallet to Solana devnet. SOL pays the transaction fees; Circle’s devnet USDC pays for stakes, donations and agent payments.', 'hd-muted'));
        tryIt.append(linkRow(doc, [
            { label: 'Solana faucet', href: 'https://faucet.solana.com' },
            { label: 'Circle USDC faucet', href: 'https://faucet.circle.com' }
        ]));
        tryIt.append(node(doc, 'p', 'Without a wallet, open the map, expand Game, turn on game mode and choose New Game. It only resets this browser’s simulation; public records and devnet transactions stay as they are.', 'hd-muted'));
        tryIt.append(linkRow(doc, [{ label: 'Open the map simulation', href: '/?reduceMotion=1' }]));
        element.append(tryIt);

        const refresh = node(doc, 'p', null, 'hd-refresh');
        refresh.append(node(doc, 'span', `Live data read ${new Date(model.generatedAt).toLocaleTimeString()}.`));
        const retry = node(doc, 'button', 'Refresh live data', 'hd-cta');
        retry.type = 'button'; retry.addEventListener('click', () => boot()); refresh.append(retry);
        element.append(refresh);
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
            publicRecords: `${base}/oracle/public-records/summary`,
            prospective: `${base}/oracle/markets/prospective/status`,
            proofManifest: `${base}/hackathon/proof.json`
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
        // The executed case exists only when the manifest declares it; there is no hardcoded fallback id.
        const caseUrls = {
            canonicalCase: values.proofManifest?.publicProof?.canonicalCase
                || `${base}/hackathon/cases/hackathon-golden-borovje-2026`,
            executedCase: values.proofManifest?.publicProof?.executedCase || null
        };
        await Promise.all(Object.entries(caseUrls).filter(([, url]) => url).map(async ([key, url]) => {
            try {
                values[key] = await fetchJson(url);
            } catch (error) {
                errors[key] = error?.message || String(error);
            }
        }));
        return { values, errors };
    }

    async function boot() {
        const element = root?.document?.getElementById('hackathon-demo');
        if (!element) return;
        const base = backendBase();
        element.textContent = 'Loading live evidence…';
        const { values, errors } = await fetchEvidence(base);
        render(element, buildDemoModel({
            runs: values.runs?.runs || [],
            events: values.activity?.events || [],
            docs: values.docs || {},
            discovery: values.discovery || null,
            oracleDiscovery: values.oracleDiscovery || null,
            oracleEvents: values.oracle?.events || [],
            publicRecords: values.publicRecords || null,
            prospectiveMarket: values.prospective || null,
            proofManifest: values.proofManifest || null,
            canonicalCase: values.canonicalCase || null,
            executedCase: values.executedCase || null,
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

    return { ageHours, backendBase, buildDemoModel, caseCardModel, caseTransactions, fetchEvidence, newest, render };
});
