// agreement-panel.js — one agreement of this device docked on the right of the map
// (plan-design-agreement.md, "M1 (b) build contract"): whether it still matches the map, its designs,
// the land it settles, who receives each resulting piece, the ledger, the decision rule and the
// deadline, with Before / after (over its input parcels), Edit and Delete. Propose puts a current
// agreement to its parties (M2, agreement-sync.js); a proposed one shows its CID with its link, the
// index's status and the owners' decisions (proposals/approval-panel.js), and is no longer edited.
// On chain (M3, solana/agreement-bridge.js): its sponsor mints a proposed binding agreement; a minted
// one shows its account, escrow, status and the lens's decision, read from the chain on open and
// after every action, with Fund and Cancel for the sponsor, Record decision, Execute and Expire for
// anyone, and Bet when the markets offer one (window.AgreementBets). A non-binding agreement (a
// community or owner vote) is never minted and has no market: its decisions are counted off-chain.
// window.AgreementPanel; the pure helpers are exported for backend/test/agreement-panel.test.js.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') {
        // The panel's four calls, and the pure helpers beside them (the Agreements list words its rows with them).
        const { browserPanel, ...helpers } = api;
        root.AgreementPanel = Object.freeze({ ...helpers, ...browserPanel(root) });
    }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const format = () => root.CbFormat || (typeof require === 'function' ? require('./format.js') : null);
    const dialogApi = () => root.AgreementDialog || (typeof require === 'function' ? require('./agreement-dialog.js') : null);
    const bridgeApi = () => root.AgreementBridge || (typeof require === 'function' ? require('./solana/agreement-bridge.js') : null);

    function t(key, fallback, params = {}) {
        let value = null;
        try {
            if (root.i18n && typeof root.i18n.t === 'function') {
                value = root.i18n.t(key, params);
                if (value === key) value = null;
            }
        } catch (_) { }
        let output = value || fallback;
        Object.keys(params).forEach(name => {
            output = String(output).replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}|\\{${name}\\}`, 'g'), String(params[name]));
        });
        return output;
    }

    function esc(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const idOf = value => (value === undefined || value === null ? '' : String(value).trim());
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const NO_VALUE = '—';

    // ---- pure helpers ----------------------------------------------------------------------------

    // The panel's title: the agreement's own, else "Agreement of <created date>".
    function titleOf(agreement, tr = t) {
        const title = agreement && typeof agreement.title === 'string' ? agreement.title.trim() : '';
        if (title) return title;
        const date = agreement && agreement.createdAt ? format().formatDate(agreement.createdAt) : '';
        return date ? tr('agreement.panel.untitled', 'Agreement of {{date}}', { date }) : tr('agreement.panel.title', 'Agreement');
    }

    // One literal key per reason code of AgreementGround.check, so the locale coverage test sees them.
    const REASON_TEXT = {
        'design-missing': tr => tr('agreement.panel.status.reasons.designMissing', 'a design was deleted'),
        'design-not-applied': tr => tr('agreement.panel.status.reasons.designNotApplied', 'a design is no longer applied'),
        'design-changed': tr => tr('agreement.panel.status.reasons.designChanged', 'a design changed'),
        'ground-changed': tr => tr('agreement.panel.status.reasons.groundChanged', 'the ground changed')
    };

    // "Matches the map", or "No longer matches the map" and why (AgreementGround.check). Each reason
    // is said once; a reason about one design names it by proposalId.
    function statusOf(check, tr = t) {
        const current = !!check && check.current === true;
        const seen = new Set();
        const reasons = [];
        if (!current) {
            (check && Array.isArray(check.reasons) ? check.reasons : []).forEach(reason => {
                const code = reason && typeof reason.code === 'string' ? reason.code : '';
                const proposalId = idOf(reason && reason.proposalId) || null;
                const text = REASON_TEXT[code];
                if (!text || seen.has(`${code}|${proposalId}`)) return;
                seen.add(`${code}|${proposalId}`);
                reasons.push({ code, proposalId, text: text(tr) });
            });
        }
        return {
            current,
            tone: current ? 'success' : 'warning',
            label: current
                ? tr('agreement.panel.status.current', 'Matches the map')
                : tr('agreement.panel.status.stale', 'No longer matches the map'),
            reasons
        };
    }

    // The land in numbers: input parcels, their recorded area (null when any of it is unknown: a
    // missing area is never 0), the resulting pieces and the open ground.
    function landSummary(agreement) {
        const parcels = agreement && agreement.inputs && Array.isArray(agreement.inputs.parcels) ? agreement.inputs.parcels : [];
        const outputs = agreement && Array.isArray(agreement.outputs) ? agreement.outputs : [];
        const openGroundM2 = agreement && agreement.inputs ? agreement.inputs.openGroundM2 : null;
        const areas = parcels.map(parcel => parcel && parcel.areaM2);
        return {
            parcels: parcels.length,
            areaM2: areas.every(finite) ? areas.reduce((sum, area) => sum + area, 0) : null,
            pieces: outputs.length,
            openGroundM2: finite(openGroundM2) ? openGroundM2 : null
        };
    }

    function percentText(share) {
        return finite(share) ? format().formatPercent(share) : '';
    }

    // "Ana 50%, Ben 50%", or that nobody is recorded (the dialog words holders the same way).
    function holdersLine(holders, tr = t, names = new Map()) {
        const list = (Array.isArray(holders) ? holders : []).filter(holder => holder && idOf(holder.ownerKey));
        if (!list.length) return tr('agreement.land.unowned', 'No recorded owner');
        return list.map(holder => {
            const key = idOf(holder.ownerKey);
            return `${holder.displayName || names.get(key) || key} ${percentText(holder.share)}`.trim();
        }).join(', ');
    }

    // Every party's name the record knows: the holders of the inputs and of the outputs.
    function partyNames(agreement) {
        const names = new Map();
        const add = holder => {
            const key = idOf(holder && holder.ownerKey);
            if (key && holder.displayName && !names.has(key)) names.set(key, String(holder.displayName));
        };
        ((agreement && agreement.inputs && agreement.inputs.parcels) || []).forEach(parcel => ((parcel && parcel.holders) || []).forEach(add));
        ((agreement && agreement.outputs) || []).forEach(output => ((output && output.holders) || []).forEach(add));
        return names;
    }

    // Who receives one piece, in words. No allocation line keeps the carried-over holders.
    function recipientText(to, output, names, tr) {
        const kind = to && to.kind;
        if (kind === 'public') return tr('agreement.allocation.public', 'Public');
        if (kind === 'party') return names.get(idOf(to.ownerKey)) || idOf(to.ownerKey);
        if (kind === 'joint') return holdersLine(to.shares, tr, names);
        const holders = output && Array.isArray(output.holders) ? output.holders : [];
        if (!holders.length) return tr('agreement.land.unowned', 'No recorded owner');
        return `${tr('agreement.allocation.holders', 'Current holders')} (${holdersLine(holders, tr, names)})`;
    }

    // One line per resulting piece, in the record's order: "Piece n", its area and who receives it.
    function allocationLines(agreement, tr = t) {
        const outputs = agreement && Array.isArray(agreement.outputs) ? agreement.outputs : [];
        const lines = new Map((agreement && Array.isArray(agreement.allocations) ? agreement.allocations : [])
            .filter(line => line && idOf(line.output)).map(line => [idOf(line.output), line.to || null]));
        const names = partyNames(agreement);
        return outputs.map((output, index) => {
            const to = lines.get(idOf(output && output.hash)) || { kind: 'holders' };
            return {
                hash: idOf(output && output.hash),
                label: `${tr('agreement.land.piece', 'Piece')} ${index + 1}`,
                areaM2: finite(output && output.areaM2) ? output.areaM2 : null,
                area: format().formatArea(output && output.areaM2, { missing: NO_VALUE }),
                kind: ['public', 'party', 'joint'].includes(to.kind) ? to.kind : 'holders',
                to: recipientText(to, output, names, tr)
            };
        });
    }

    function signedArea(m2) {
        if (!finite(m2)) return NO_VALUE;
        if (Math.abs(m2) < 0.05) return format().formatArea(0, { maxFractionDigits: 0 });
        return (m2 > 0 ? '+' : '−') + format().formatArea(Math.abs(m2));
    }

    function euroText(cents) {
        const digits = cents % 100 === 0 ? 0 : 2;
        return format().formatMoney(cents / 100, 'EUR', { maxFractionDigits: digits, minFractionDigits: digits });
    }

    function signedMoney(cents) {
        if (!finite(cents) || cents === 0) return NO_VALUE;
        return (cents > 0 ? '+' : '−') + euroText(Math.abs(cents));
    }

    // The ledger (AgreementRecord.ledger) as table rows: what each party puts in and receives, the
    // net change and the cash (+ receives, − pays); the public's land last. A party whose input area
    // is not known has no contribution or change to show.
    function ledgerRows(ledger, tr = t) {
        const area = value => format().formatArea(value, { missing: NO_VALUE });
        const rows = (ledger && Array.isArray(ledger.parties) ? ledger.parties : []).map(party => ({
            ownerKey: idOf(party.ownerKey),
            name: party.displayName || idOf(party.ownerKey),
            contributes: party.areaUnknown ? NO_VALUE : area(party.contributedM2),
            receives: area(party.assignedM2),
            change: party.areaUnknown ? NO_VALUE : signedArea(party.changeM2),
            cash: signedMoney(party.cashCents)
        }));
        if (ledger && finite(ledger.publicM2) && ledger.publicM2 > 0) {
            rows.push({
                ownerKey: null, name: tr('agreement.allocation.public', 'Public'),
                contributes: NO_VALUE, receives: area(ledger.publicM2), change: signedArea(ledger.publicM2), cash: NO_VALUE
            });
        }
        return rows;
    }

    // Who decides and whether it binds; for the owners, the approval rule in one line.
    function ruleSummary(rule, tr = t, summaryText = null) {
        const owners = !!rule && rule.electorate === 'owners';
        return {
            electorate: owners
                ? tr('agreement.rule.electorate.owners', 'Decided by the owners')
                : tr('agreement.rule.electorate.community', 'Decided by a community vote'),
            binding: rule && rule.binding === true
                ? tr('agreement.rule.binding', 'Binding: when the rule is met, land and money move at execution')
                : tr('agreement.rule.nonBinding', 'Non-binding'),
            detail: owners && typeof summaryText === 'function' ? summaryText(rule.approvalConfig, rule.lens) : ''
        };
    }

    // The rule in one short line, for a list row.
    function ruleShort(rule, tr = t) {
        const { electorate } = ruleSummary(rule, tr);
        const binding = rule && rule.binding === true
            ? tr('agreement.rule.bindingShort', 'Binding')
            : tr('agreement.rule.nonBinding', 'Non-binding');
        return `${electorate} · ${binding}`;
    }

    // The designs the agreement names, as this browser holds them now: a deleted one cannot be
    // selected, an applied one carries the Applied badge.
    function designRows(agreement, { designOf, isApplied, typeLabel } = {}) {
        return (agreement && Array.isArray(agreement.designs) ? agreement.designs : []).map(design => {
            const proposalId = idOf(design && design.proposalId);
            const record = typeof designOf === 'function' ? designOf(proposalId) : null;
            return {
                proposalId,
                title: (design && design.title) || (record && (record.title || record.name)) || t('modal.roadWidth.proposalList.untitled', 'Untitled proposal'),
                type: typeof typeLabel === 'function' ? typeLabel(record || design) || '' : '',
                missing: !record,
                applied: !!record && typeof isApplied === 'function' && !!isApplied(record)
            };
        });
    }

    // The cadastral ids whose original features the ground check reads: the stored inputs, and what
    // the designs held here take now (AgreementDialog.inputParcelIds, the ids AgreementGround.derive
    // looks up).
    function groundIds(agreement, records, fabric) {
        const ids = new Set(((agreement && agreement.inputs && agreement.inputs.parcels) || []).map(parcel => idOf(parcel && parcel.parcelId)).filter(Boolean));
        dialogApi().inputParcelIds(records, fabric).forEach(id => ids.add(id));
        return Array.from(ids).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    // ---- HTML (pure) -----------------------------------------------------------------------------

    const sectionHtml = (title, content) => `<section class="agreement-panel-section"><h4 class="agreement-panel-heading">${esc(title)}</h4>${content}</section>`;

    function statusHtml({ checking, error, status, designTitles }, tr = t) {
        if (error) {
            return `<p class="agreement-panel-note agreement-panel-note--danger" role="alert">${esc(tr('agreement.panel.status.error', 'The agreement could not be checked against the map: {{reason}}', { reason: error }))}</p>`;
        }
        if (checking || !status) return `<p class="agreement-panel-hint" role="status">${esc(tr('agreement.land.loading', 'Reading the land under the designs…'))}</p>`;
        const titles = designTitles instanceof Map ? designTitles : new Map();
        const reasons = status.reasons.map(reason => (reason.proposalId && titles.get(reason.proposalId)
            ? `${reason.text} (${titles.get(reason.proposalId)})` : reason.text)).join('; ');
        return `<div class="agreement-panel-status" role="status" data-agreement-status="${status.current ? 'current' : 'stale'}">`
            + `<span class="cb-badge cb-badge--${status.tone}">${esc(status.label)}</span>`
            + (reasons ? `<p class="agreement-panel-reasons">${esc(reasons)}</p>` : '')
            + '</div>';
    }

    // Propose is the main action of a current agreement not yet proposed; a proposed agreement is
    // immutable, so it has no Edit (a change is a new agreement). Bet appears when the markets offer
    // one on the agreement (window.AgreementBets.available).
    function actionsHtml({ canCompare = false, comparing = false, canPropose = false, published = false, canBet = false } = {}, tr = t) {
        return '<div class="agreement-panel-actions">'
            + (canPropose ? `<button type="button" class="btn btn-primary" data-agreement-action="propose"><i class="fas fa-paper-plane" aria-hidden="true"></i> ${esc(tr('agreement.publish.propose', 'Propose'))}</button>` : '')
            + `<button type="button" class="btn${canPropose ? '' : ' btn-primary'}" data-agreement-action="compare" aria-pressed="${comparing ? 'true' : 'false'}"${canCompare ? '' : ' disabled'}>`
            + `<i class="fas fa-left-right" aria-hidden="true"></i> ${esc(tr('mapCompare.toggle', 'Before / after'))}</button>`
            + (canBet ? `<button type="button" class="btn" data-agreement-action="bet"><i class="fas fa-chart-line" aria-hidden="true"></i> ${esc(tr('agreement.panel.actions.bet', 'Bet'))}</button>` : '')
            + (published ? '' : `<button type="button" class="btn" data-agreement-action="edit"><i class="fas fa-pen" aria-hidden="true"></i> ${esc(tr('agreement.panel.actions.edit', 'Edit'))}</button>`)
            + `<button type="button" class="btn btn-danger" data-agreement-action="delete"><i class="fas fa-trash" aria-hidden="true"></i> ${esc(tr('agreement.panel.actions.delete', 'Delete'))}</button>`
            + '</div>';
    }

    // ---- the chain (M3) --------------------------------------------------------------------------

    // "AbCd…wXyZ": enough of a base58 key to recognise it; the whole key is in the title.
    function shortKey(key) {
        const text = idOf(key);
        return text.length > 12 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
    }

    const solText = lamports => format().formatMoney(bridgeApi().solOf(lamports), 'SOL', { maxFractionDigits: 9, minFractionDigits: 0 });

    // One literal key per chain status and decision (AgreementClient.STATUS_NAMES, DECISION_NAMES),
    // so the locale coverage test sees them; the badge tone follows the shared badge vocabulary.
    const CHAIN_STATUS = {
        Active: { tone: 'minted', text: tr => tr('agreement.chain.status.active', 'Active') },
        Executed: { tone: 'executed', text: tr => tr('agreement.chain.status.executed', 'Executed') },
        Cancelled: { tone: 'withdrawn', text: tr => tr('agreement.chain.status.cancelled', 'Cancelled') },
        Expired: { tone: 'expired', text: tr => tr('agreement.chain.status.expired', 'Expired') }
    };
    // A lens attests only "satisfied": a decision is Pending until then (there are no refusals).
    const CHAIN_DECISION = {
        Pending: { tone: 'neutral', text: tr => tr('agreement.chain.decision.pending', 'Pending') },
        Satisfied: { tone: 'success', text: tr => tr('agreement.chain.decision.satisfied', 'Satisfied') }
    };
    // What a running chain action is doing (the bridge's onStatus states, then the index mirror).
    const CHAIN_PHASE = {
        preparing: tr => tr('agreement.chain.phase.preparing', 'Preparing the transaction…'),
        awaiting_signature: tr => tr('agreement.chain.phase.awaitingSignature', 'Waiting for the wallet’s signature…'),
        submitted: tr => tr('agreement.chain.phase.submitted', 'Sent; waiting for confirmation…'),
        confirmed: tr => tr('agreement.chain.phase.confirmed', 'Confirmed.'),
        indexing: tr => tr('agreement.chain.phase.indexing', 'Recording the mint on the server…')
    };

    const badgeHtml = (entry, label, attribute) => `<span class="cb-badge cb-badge--${entry ? entry.tone : 'neutral'}" ${attribute}>${esc(label)}</span>`;

    // A chain status in words, spelled as the index records it ('active') or as the account decoder
    // names it ('Active').
    function chainStatusText(status, tr = t) {
        const key = idOf(status);
        const entry = CHAIN_STATUS[key.charAt(0).toUpperCase() + key.slice(1).toLowerCase()];
        return entry ? entry.text(tr) : key;
    }

    function chainButton(action, icon, label, { tone = '', disabled = false } = {}) {
        return `<button type="button" class="btn${tone ? ` btn-${tone}` : ''}" data-agreement-action="${action}"${disabled ? ' disabled' : ''}>`
            + `<i class="${icon}" aria-hidden="true"></i> ${esc(label)}</button>`;
    }

    const hintsHtml = hints => hints.map(hint => `<p class="agreement-panel-hint">${esc(hint)}</p>`).join('');

    /**
     * Whether a proposed, unminted agreement can be minted from here and, when not, why. `sponsor` is
     * the wallet it was proposed with (published.sponsor), `wallet` the connected Solana wallet, `lens`
     * the member its mint would name (AgreementBridge.mintLens). An agreement proposed without a
     * sponsor can only be proposed again (`repropose`), which needs a connected wallet.
     */
    function mintReadiness({ sponsor = null, wallet = null, lens = null, electorate = 'owners', deadlinePassed = false } = {}, tr = t) {
        if (!sponsor) {
            return {
                canMint: false, repropose: true, canRepropose: !!wallet,
                hints: [tr('agreement.chain.hints.noSponsor', 'It was proposed without a sponsor wallet, so it cannot be minted. Propose it again with a Solana wallet connected: that is a new agreement, with its own link and decisions.')]
            };
        }
        const hints = [];
        if (!wallet) hints.push(tr('agreement.chain.hints.connectSponsor', 'Connect the sponsor’s Solana wallet ({{sponsor}}) to mint it.', { sponsor: shortKey(sponsor) }));
        else if (wallet !== sponsor) hints.push(tr('agreement.chain.hints.notSponsor', 'Only the sponsor’s wallet ({{sponsor}}) can mint it; the connected wallet is {{wallet}}.', { sponsor: shortKey(sponsor), wallet: shortKey(wallet) }));
        if (!lens) {
            hints.push(electorate === 'owners'
                ? tr('agreement.chain.hints.noRuleLens', 'Its decision rule names no lens member, so no lens can attest its decision.')
                : tr('agreement.chain.hints.noConfiguredLens', 'Choose a lens member in the lens settings: it attests the vote count.'));
        }
        if (deadlinePassed) hints.push(tr('agreement.chain.hints.deadlinePassed', 'Its deadline has passed.'));
        return { canMint: !hints.length, repropose: false, canRepropose: false, hints };
    }

    // Only a binding rule moves land and money at execution, so only a binding agreement is minted
    // and bet on (user decision, 2026-10-22).
    const isBinding = agreement => !!agreement && !!agreement.rule && agreement.rule.binding === true;

    // The "On chain" section of a proposed non-binding agreement: one line saying why it has none.
    function nonBindingChainHtml(published, tr = t) {
        if (!published) return '';
        return sectionHtml(tr('agreement.chain.heading', 'On chain'),
            `<p class="agreement-panel-note" data-agreement-chain="non-binding">${esc(tr('agreement.chain.nonBinding', 'A vote is not minted; its decisions are counted off-chain.'))}</p>`);
    }

    /**
     * The "On chain" section of a proposed agreement. view: { published, ref ({ cluster, account } or
     * null), wallet, lens, electorate, deadlinePassed, chain ({ loading, error, value, lensError } of
     * the account read back), actions (AgreementBridge.chainActions), attestation (the address of the
     * lens's decision its member lists, or null), busy ({ action, phase } of a running action, or null) }.
     */
    function chainHtml(view, tr = t) {
        if (!view || !view.published) return '';
        const busy = view.busy ? `<p class="agreement-panel-hint" role="status" data-agreement-chain-busy="${esc(view.busy.action)}">${esc((CHAIN_PHASE[view.busy.phase] || CHAIN_PHASE.preparing)(tr))}</p>` : '';
        const locked = !!view.busy;
        const title = tr('agreement.chain.heading', 'On chain');
        if (!view.ref) {
            const ready = mintReadiness(view, tr);
            const button = ready.repropose
                ? chainButton('repropose', 'fas fa-paper-plane', tr('agreement.chain.actions.repropose', 'Propose again with this wallet'), { tone: 'primary', disabled: locked || !ready.canRepropose })
                : chainButton('mint', 'fas fa-cube', tr('agreement.chain.actions.mint', 'Mint'), { tone: 'primary', disabled: locked || !ready.canMint });
            return sectionHtml(title, '<div class="agreement-chain" data-agreement-chain="unminted">'
                + `<p class="agreement-panel-meta">${esc(tr('agreement.chain.notMinted', 'Not minted. Minting commits this agreement to Solana at its sponsor’s address; its lens then attests the decision, and executing it releases the escrow.'))}</p>`
                + `<div class="agreement-panel-actions">${button}</div>${hintsHtml(ready.hints)}${busy}</div>`);
        }
        const ref = view.ref;
        const link = bridgeApi().explorerUrl({ account: ref.account, cluster: ref.cluster });
        const head = '<div class="agreement-chain-head">'
            + `<a class="cb-link cb-link--external agreement-chain-account" href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="${esc(ref.account)}">${esc(shortKey(ref.account))}</a>`
            + `<span class="agreement-panel-meta">${esc(tr('agreement.chain.cluster', 'Solana {{cluster}}', { cluster: ref.cluster }))}</span></div>`;
        const chain = view.chain || { loading: true };
        if (chain.loading) return sectionHtml(title, `<div class="agreement-chain" data-agreement-chain="loading">${head}<p class="agreement-panel-hint" role="status">${esc(tr('agreement.chain.reading', 'Reading the chain…'))}</p>${busy}</div>`);
        if (chain.error) {
            return sectionHtml(title, `<div class="agreement-chain" data-agreement-chain="error">${head}`
                + `<p class="agreement-panel-note agreement-panel-note--danger" role="alert">${esc(tr('agreement.chain.readFailed', 'The chain account could not be read: {{reason}}', { reason: chain.error }))}</p>${busy}</div>`);
        }
        const value = chain.value;
        if (!value) {
            return sectionHtml(title, `<div class="agreement-chain" data-agreement-chain="missing">${head}`
                + `<p class="agreement-panel-note agreement-panel-note--danger" role="alert">${esc(tr('agreement.chain.missing', 'The account is not on Solana {{cluster}}.', { cluster: ref.cluster }))}</p>${busy}</div>`);
        }
        const status = CHAIN_STATUS[value.status];
        const decision = CHAIN_DECISION[value.decision];
        const required = value.requiredLamports > 0n;
        const escrow = required
            ? tr('agreement.chain.escrowOf', '{{escrow}} of {{required}}', { escrow: solText(value.escrowLamports), required: solText(value.requiredLamports) })
            : tr('agreement.chain.escrowNoneRequired', '{{escrow}} (none required)', { escrow: solText(value.escrowLamports) });
        const facts = [
            [tr('agreement.chain.facts.status', 'Status'), badgeHtml(status, status ? status.text(tr) : value.status, `data-agreement-chain-status="${esc(value.status)}"`)],
            [tr('agreement.chain.facts.decision', 'Decision'), badgeHtml(decision, decision ? decision.text(tr) : value.decision, `data-agreement-chain-decision="${esc(value.decision)}"`)],
            [tr('agreement.chain.facts.escrow', 'Escrow'), esc(escrow)],
            [tr('agreement.chain.facts.deadline', 'Deadline'), esc(value.deadline ? format().formatDateTime(value.deadline) : tr('agreement.chain.noDeadline', 'None'))],
            [tr('agreement.chain.facts.lens', 'Lens'), `<code title="${esc(value.lens)}">${esc(shortKey(value.lens))}</code>`],
            [tr('agreement.chain.facts.payout', 'Payout'), `<code title="${esc(value.payout)}">${esc(shortKey(value.payout))}</code>`]
        ];
        if (value.executedAt) facts.push([tr('agreement.chain.facts.executedAt', 'Executed'), esc(format().formatDateTime(value.executedAt))]);
        const factsHtml = `<dl class="agreement-panel-facts">${facts.map(([label, html]) => `<div><dt>${esc(label)}</dt><dd>${html}</dd></div>`).join('')}</dl>`;

        const actions = view.actions || {};
        const active = value.status === 'Active';
        const buttons = [];
        const hints = [];
        if (active) {
            if (view.attestation && value.decision === 'Pending') {
                buttons.push(chainButton('attest', 'fas fa-stamp', tr('agreement.chain.actions.attest', 'Record decision'), { tone: 'primary', disabled: locked || !actions.attest }));
            }
            buttons.push(chainButton('execute', 'fas fa-play', tr('agreement.chain.actions.execute', 'Execute'), { tone: value.decision === 'Satisfied' ? 'primary' : '', disabled: locked || !actions.execute }));
            if (actions.authority) {
                buttons.push(chainButton('fund', 'fas fa-coins', tr('agreement.chain.actions.fund', 'Fund'), { disabled: locked || !actions.fund }));
                buttons.push(chainButton('cancel', 'fas fa-ban', tr('agreement.chain.actions.cancel', 'Cancel'), { tone: 'danger', disabled: locked || !actions.cancel }));
            }
            if (actions.deadlinePassed) buttons.push(chainButton('expire', 'fas fa-hourglass-end', tr('agreement.chain.actions.expire', 'Expire'), { disabled: locked || !actions.expire }));
            if (!view.wallet) hints.push(tr('agreement.chain.hints.connectWallet', 'Connect a Solana wallet to act on it.'));
            if (value.decision === 'Pending' && chain.lensError) hints.push(chain.lensError);
            else if (value.decision === 'Pending' && !view.attestation && !actions.deadlinePassed) hints.push(tr('agreement.chain.hints.awaitingLens', 'Waiting for its lens to attest the decision.'));
            if (value.decision === 'Pending' && view.attestation) hints.push(tr('agreement.chain.hints.attested', 'Its lens has attested the decision: record it on chain.'));
            if (value.decision === 'Satisfied' && !actions.funded) hints.push(tr('agreement.chain.hints.awaitingFunds', 'Execution waits until the escrow holds {{required}}.', { required: solText(value.requiredLamports) }));
            if (actions.deadlinePassed) hints.push(tr('agreement.chain.hints.expired', 'Its deadline has passed: anyone can expire it, which returns the escrow to the sponsor.'));
        }
        return sectionHtml(title, `<div class="agreement-chain" data-agreement-chain="minted">${head}${factsHtml}`
            + (buttons.length ? `<div class="agreement-panel-actions">${buttons.join('')}</div>` : '')
            + `${hintsHtml(hints)}${busy}</div>`);
    }

    // The index's status of a proposed agreement, in words: active, expired, or not read (yet).
    function remoteStatusOf(remote, tr = t) {
        if (!remote || remote.loading) return { tone: 'neutral', label: tr('agreement.publish.statusChecking', 'Checking the server…') };
        if (remote.error) return { tone: 'warning', label: tr('agreement.publish.statusUnavailable', 'Server status unavailable: {{reason}}', { reason: remote.error }) };
        if (remote.status === 'expired') return { tone: 'danger', label: tr('agreement.publish.statusExpired', 'Expired') };
        return { tone: 'success', label: tr('agreement.publish.statusActive', 'Active') };
    }

    // A proposed agreement: its CID (shortened; the whole one in the title), Copy link, the index's
    // status, and where its parties decide: the owners' card, or the community note.
    function publishedHtml({ published, remote = null, electorate = 'owners' } = {}, tr = t) {
        if (!published) return '';
        const cid = idOf(published.cid);
        const short = cid.length > 20 ? `${cid.slice(0, 12)}…${cid.slice(-6)}` : cid;
        const status = remoteStatusOf(remote, tr);
        const decide = electorate === 'owners'
            ? '<div class="approval-card-slot" data-approval-card-slot></div>'
            : `<p class="agreement-panel-note" data-agreement-community-note>${esc(tr('agreement.publish.communityNote', 'Votes on a community rule are counted off-chain in M3.'))}</p>`;
        return sectionHtml(tr('threeMode.parcelPanel.proposed', 'Proposed'),
            '<div class="agreement-panel-published">'
            + `<code class="agreement-panel-cid" title="${esc(cid)}">${esc(short)}</code>`
            + `<button type="button" class="btn btn-sm" data-agreement-action="link"><i class="fas fa-link" aria-hidden="true"></i> ${esc(tr('agreement.publish.copyLink', 'Copy link'))}</button>`
            + `<span class="cb-badge cb-badge--${status.tone}" data-agreement-remote-status="${esc((remote && remote.status) || '')}">${esc(status.label)}</span>`
            + '</div>'
            + decide);
    }

    function designsHtml(rows, tr = t) {
        const items = rows.map(row => `<li><button type="button" class="btn btn-quiet agreement-panel-design" data-agreement-design="${esc(row.proposalId)}"${row.missing ? ' disabled' : ''}>`
            + `<span class="agreement-panel-design__text"><span class="agreement-panel-design__title">${esc(row.title)}</span>`
            + (row.type ? `<span class="agreement-panel-design__type">${esc(row.type)}</span>` : '') + '</span>'
            + (row.applied ? `<span class="cb-badge cb-badge--applied">${esc(tr('agreement.designs.onMap', 'Applied'))}</span>` : '')
            + '</button></li>').join('');
        return sectionHtml(tr('agreement.sections.designs', 'Designs'), `<ul class="agreement-panel-designs">${items}</ul>`);
    }

    function landHtml(summary, tr = t) {
        const facts = [
            [tr('agreement.land.inputsHeading', 'Input parcels'), format().formatInteger(summary.parcels)],
            [tr('agreement.land.area', 'Area'), format().formatArea(summary.areaM2, { missing: NO_VALUE })],
            [tr('agreement.land.outputsHeading', 'Resulting pieces'), format().formatInteger(summary.pieces)]
        ];
        const openGround = finite(summary.openGroundM2) && summary.openGroundM2 > 0
            ? `<p class="agreement-panel-meta">${esc(tr('agreement.land.openGround', 'Open ground: {{area}}', { area: format().formatArea(summary.openGroundM2) }))}</p>`
            : '';
        return sectionHtml(tr('agreement.sections.land', 'Land'),
            `<dl class="agreement-panel-facts">${facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>${openGround}`);
    }

    function allocationHtml(lines, tr = t) {
        if (!lines.length) return '';
        const items = lines.map(line => `<li class="agreement-panel-allocation" data-agreement-piece="${esc(line.hash)}">`
            + `<span class="agreement-panel-allocation__piece">${esc(line.label)}</span>`
            + `<span class="agreement-panel-allocation__area">${esc(line.area)}</span>`
            + `<span class="agreement-panel-allocation__to"><i class="fas fa-arrow-right" aria-hidden="true"></i> ${esc(line.to)}</span></li>`).join('');
        return sectionHtml(tr('agreement.sections.allocation', 'Allocation'), `<ul class="agreement-panel-allocations">${items}</ul>`);
    }

    function ledgerHtml({ rows = [], sponsor = '', error = null } = {}, tr = t) {
        const title = tr('agreement.panel.ledgerHeading', 'Ledger');
        if (error) return sectionHtml(title, `<p class="agreement-panel-note agreement-panel-note--danger" role="alert">${esc(error)}</p>`);
        if (!rows.length) return '';
        const head = [
            tr('agreement.money.party', 'Party'), tr('agreement.panel.ledger.contributes', 'Contributes'), tr('agreement.panel.ledger.receives', 'Receives'),
            tr('agreement.panel.ledger.change', 'Net change'), tr('agreement.panel.ledger.cash', 'Cash')
        ];
        const body = rows.map(row => `<tr><th scope="row">${esc(row.name)}</th><td>${esc(row.contributes)}</td><td>${esc(row.receives)}</td>`
            + `<td>${esc(row.change)}</td><td>${esc(row.cash)}</td></tr>`).join('');
        return sectionHtml(title, '<div class="agreement-panel-ledger-scroll"><table class="agreement-panel-ledger">'
            + `<thead><tr>${head.map(label => `<th scope="col">${esc(label)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`
            + (sponsor ? `<p class="agreement-panel-meta">${esc(sponsor)}</p>` : ''));
    }

    function ruleHtml(summary, deadline, tr = t) {
        return sectionHtml(tr('agreement.sections.rule', 'Decision rule'),
            `<p class="agreement-panel-rule">${esc(summary.electorate)} · ${esc(summary.binding)}</p>`
            + (summary.detail ? `<p class="agreement-panel-meta">${esc(summary.detail)}</p>` : '')
            + (deadline ? `<p class="agreement-panel-meta">${esc(tr('agreement.panel.deadline', 'Deadline: {{date}}', { date: deadline }))}</p>` : ''));
    }

    // ---- the browser panel -----------------------------------------------------------------------

    function browserPanel(win) {
        const doc = win.document;
        // remote: the index's row of a proposed agreement ({ cid, loading, status, error, onchain }), read
        // once per open and after each chain action. chain: the minted account as read back ({ account,
        // loading, value, error }); chainBusy: the chain action running ({ action, phase }).
        const state = {
            token: 0, id: null, agreement: null, check: null, checking: false, error: null, panel: null, wired: false, remote: null,
            chain: null, chainToken: 0, chainBusy: null
        };
        const log = (message, ...rest) => console.log(`[${new Date().toISOString()}] [AgreementPanel] ${message}`, ...rest);
        const isOpen = () => !!(state.panel && state.panel.classList.contains('visible'));
        const designOf = id => (win.proposalStorage && typeof win.proposalStorage.getProposal === 'function' ? win.proposalStorage.getProposal(id) || null : null);
        const typeLabel = record => {
            const key = win.ProposalDesignGoals && typeof win.ProposalDesignGoals.keyOf === 'function' ? win.ProposalDesignGoals.keyOf(record) : null;
            return key && typeof win.formatProposalTypeLabel === 'function' ? win.formatProposalTypeLabel(key) : '';
        };
        const compareKey = id => win.ProposalBeforeAfter.agreementKey(id);
        const comparing = id => !!id && !!win.ProposalBeforeAfter && win.ProposalBeforeAfter.isActive(compareKey(id));

        function store() {
            if (!win.AgreementStore) throw new Error('AgreementStore is not loaded.');
            return win.AgreementStore;
        }

        // The original cadastral features of `ids`, kept in the repository (before-after.js reads the
        // same ones). Without them the check still stands: AgreementGround only measures areas from them.
        async function originalFeatures(ids) {
            const repository = win.CadastralParcelRepository;
            if (!ids.length || win.ParcelGroundFallback?.isWithoutParcels?.()) return [];
            if (!repository || typeof repository.ensureIds !== 'function') throw new Error('The cadastral parcel repository is not loaded.');
            try {
                const result = await repository.ensureIds(ids, { retainOnly: true });
                return Array.isArray(result && result.features) ? result.features : [];
            } catch (error) {
                console.warn(`[${new Date().toISOString()}] [AgreementPanel] original parcels unavailable`, error);
                return [];
            }
        }

        async function checkAgreement(agreement) {
            const ground = win.AgreementGround;
            if (!ground || typeof ground.check !== 'function') throw new Error('AgreementGround is not loaded.');
            const fabric = win.LiveParcelFabric;
            const records = (agreement.designs || []).map(design => designOf(design.proposalId)).filter(Boolean);
            const features = await originalFeatures(groundIds(agreement, records, fabric));
            return ground.check(agreement, {
                designOf,
                isApplied: win.isApplied,
                fingerprintOf: record => win.DesignRecord.cidOf(record),
                fabric,
                originals: dialogApi().originalsById(features, fabric && fabric.featureId),
                ownerOf: ground.localHolders({ storage: win.PersistentStorage, agents: win.agentStorage }),
                area: feature => win.turf.area(feature)
            });
        }

        function ensurePanel() {
            if (state.panel) return state.panel;
            const panel = doc.createElement('section');
            panel.id = 'agreement-panel';
            panel.className = 'info-panel right-dock-panel agreement-panel';
            panel.setAttribute('role', 'region');
            panel.setAttribute('aria-labelledby', 'agreement-panel-title');
            panel.innerHTML = `
                <div class="panel-header">
                    <h3 id="agreement-panel-title"></h3>
                    <button type="button" class="close-circle-btn close-circle-btn--lg close-button" data-agreement-action="close">×</button>
                </div>
                <div class="panel-body" data-agreement-region="body"></div>`;
            panel.addEventListener('click', onPanelClick);
            (doc.getElementById('map-container') || doc.body).appendChild(panel);
            state.panel = panel;
            return panel;
        }

        function bodyHtml() {
            const agreement = state.agreement;
            const status = statusHtml({
                checking: state.checking, error: state.error,
                status: state.check ? statusOf(state.check) : null,
                designTitles: new Map(((agreement && agreement.designs) || []).map(design => [idOf(design.proposalId), design.title || '']))
            });
            if (!agreement) return status;
            let ledger = { rows: [], sponsor: '', error: null };
            try {
                const computed = win.AgreementRecord.ledger(agreement);
                const sponsor = dialogApi().sponsorLine(computed.money);
                ledger = { rows: ledgerRows(computed), sponsor: sponsor ? sponsor.text : '', error: null };
            } catch (error) {
                console.error(`[${new Date().toISOString()}] [AgreementPanel] the ledger of ${state.id} could not be computed`, error);
                ledger.error = error && error.message ? error.message : String(error);
            }
            const setup = win.ProposalApprovalSetup;
            const rule = ruleSummary(agreement.rule, t, setup && typeof setup.summaryText === 'function' ? setup.summaryText : null);
            const deadline = agreement.deadline ? format().formatDate(agreement.deadline) : '';
            const current = !!state.check && state.check.current === true && !state.checking && !state.error;
            const published = !!agreement.published;
            const binding = isBinding(agreement);
            // An agreement imported from its link whose pieces did not re-derive here keeps them by hash.
            const byHashOnly = (agreement.outputs || []).some(output => !output.geometry)
                ? `<p class="agreement-panel-note" data-agreement-rederive>${esc(t('agreement.publish.rederive', 'Its pieces are known here by their hashes only: apply its designs on the same ground to re-derive them and compare.'))}</p>`
                : '';
            return status
                + byHashOnly
                + actionsHtml({ canCompare: current, comparing: comparing(state.id), canPropose: current && !published, published, canBet: binding && betAvailable(agreement) })
                + publishedHtml({ published: agreement.published, remote: state.remote, electorate: agreement.rule && agreement.rule.electorate })
                + (binding ? chainHtml(chainView(agreement)) : nonBindingChainHtml(agreement.published))
                + designsHtml(designRows(agreement, { designOf, isApplied: win.isApplied, typeLabel }))
                + landHtml(landSummary(agreement))
                + allocationHtml(allocationLines(agreement))
                + ledgerHtml(ledger)
                + ruleHtml(rule, deadline);
        }

        function renderPanel() {
            const panel = ensurePanel();
            panel.querySelector('#agreement-panel-title').textContent = state.agreement ? titleOf(state.agreement) : t('agreement.panel.title', 'Agreement');
            const close = panel.querySelector('[data-agreement-action="close"]');
            const closeLabel = t('modal.common.close', 'Close');
            close.setAttribute('aria-label', closeLabel);
            close.title = closeLabel;
            panel.querySelector('[data-agreement-region="body"]').innerHTML = bodyHtml();
            // The owners' decisions on a proposed agreement (proposals/approval-panel.js).
            const slot = panel.querySelector('[data-approval-card-slot]');
            if (slot && win.ProposalApprovalPanel) win.ProposalApprovalPanel.render(slot, state.id);
            panel.classList.add('visible');
            doc.body.classList.add('agreement-panel-open');
        }

        // ---- the chain (M3) ----------------------------------------------------------------------

        // The markets offer a bet on this agreement (window.AgreementBets, js/bets/).
        function betAvailable(agreement) {
            const bets = win.AgreementBets;
            if (!bets || typeof bets.available !== 'function' || !agreement) return false;
            try {
                return bets.available(agreement) === true;
            } catch (error) {
                console.error(`[${new Date().toISOString()}] [AgreementPanel] AgreementBets.available failed for ${agreement.id}`, error);
                return false;
            }
        }

        // The lens member a mint of this agreement names (AgreementBridge.mintLens): the rule's, or for
        // a community rule the first one configured in the lens settings (LensPicker).
        function mintLensOf(agreement) {
            const configured = win.LensPicker && typeof win.LensPicker.getEntries === 'function' ? win.LensPicker.getEntries() : [];
            return win.AgreementBridge.mintLens(agreement, configured);
        }

        // Everything the "On chain" section shows (chainHtml), from the record, the connected wallet,
        // the account read back and the index's row.
        function chainView(agreement) {
            if (!agreement || !agreement.published || !win.AgreementBridge) return null;
            const bridge = win.AgreementBridge;
            const wallet = bridge.connectedWallet();
            const ref = bridge.onchainRef(agreement);
            const deadlineMs = agreement.deadline ? Date.parse(agreement.deadline) : NaN;
            const chain = ref && state.chain && state.chain.account === ref.account ? state.chain : (ref ? { loading: true } : null);
            const attestation = chain && chain.attestation ? chain.attestation : null;
            let actions = null;
            if (chain && chain.value) {
                try {
                    actions = bridge.chainActions(chain.value, { wallet, attestation });
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] [AgreementPanel] the chain actions of ${agreement.id} could not be worked out`, error);
                }
            }
            return {
                published: agreement.published,
                sponsor: agreement.published.sponsor || null,
                ref,
                wallet,
                lens: ref ? null : mintLensOf(agreement),
                electorate: agreement.rule && agreement.rule.electorate,
                deadlinePassed: Number.isFinite(deadlineMs) && deadlineMs <= Date.now(),
                chain,
                actions,
                attestation,
                busy: state.chainBusy
            };
        }

        // Reads the minted account again (the chain is the truth), and while its decision is pending
        // asks its lens member for the decision (AgreementBridge.findAttestation); a newer read wins.
        async function readChain(agreement) {
            const ref = agreement && win.AgreementBridge ? win.AgreementBridge.onchainRef(agreement) : null;
            if (!ref) {
                state.chain = null;
                return;
            }
            const id = agreement.id;
            const token = ++state.chainToken;
            const current = () => state.id === id && token === state.chainToken;
            state.chain = { account: ref.account, loading: true, value: null, error: null, attestation: null, lensError: null };
            if (isOpen() && state.id === id) renderPanel();
            let value = null;
            try {
                value = await win.AgreementBridge.read(agreement);
                if (!current()) return;
                state.chain = { account: ref.account, loading: false, value, error: null, attestation: null, lensError: null };
                log(`${id}: ${ref.account} on ${ref.cluster} is ${value ? `${value.status}, decision ${value.decision}, escrow ${value.escrowLamports}/${value.requiredLamports} lamports` : 'not on chain'}`);
            } catch (error) {
                if (!current()) return;
                console.warn(`[${new Date().toISOString()}] [AgreementPanel] ${ref.account} could not be read`, error);
                state.chain = { account: ref.account, loading: false, value: null, error: (error && error.message) || String(error), attestation: null, lensError: null };
            }
            if (isOpen() && state.id === id) renderPanel();
            if (!value || value.status !== 'Active' || value.decision !== 'Pending') return;
            try {
                const found = await win.AgreementBridge.findAttestation(agreement, value);
                if (!current()) return;
                state.chain = { ...state.chain, attestation: found ? found.address : null };
            } catch (error) {
                if (!current()) return;
                console.warn(`[${new Date().toISOString()}] [AgreementPanel] the lens decision of ${id} could not be looked up`, error);
                state.chain = { ...state.chain, lensError: (error && error.message) || String(error) };
            }
            if (isOpen() && state.id === id) renderPanel();
        }

        // Reads the account when it is not the one read already: on open, after a mint, after the
        // index's record of a mint made elsewhere is adopted. A non-binding agreement has none.
        function syncChain(agreement) {
            const ref = isBinding(agreement) && win.AgreementBridge ? win.AgreementBridge.onchainRef(agreement) : null;
            if (!ref) {
                state.chain = null;
                return;
            }
            if (state.chain && state.chain.account === ref.account) return;
            readChain(agreement);
        }

        // The index is the usual lookup of the chain account: its record of a mint this device does not
        // know is kept here, and a mint made here that it lacks is sent to it again.
        function reconcileOnchain(id, indexed) {
            const agreement = store().get(id);
            if (!agreement || !agreement.published || !isBinding(agreement) || !win.AgreementBridge) return;
            const local = win.AgreementBridge.onchainRef(agreement);
            const remote = indexed ? win.AgreementBridge.onchainRef({ onchain: indexed }) : null;
            try {
                if (remote && !local) {
                    log(`${id}: the index records its mint at ${remote.account} (${remote.cluster}); keeping it here`);
                    win.AgreementSync.adoptOnchain(id, indexed);
                } else if (local && !remote) {
                    log(`${id}: the index lacks its mint at ${local.account}; sending it again`);
                    win.AgreementSync.recordOnchain(id, { chain: 'solana', cluster: local.cluster, account: local.account, signature: agreement.onchain.signature || null })
                        .catch(error => console.warn(`[${new Date().toISOString()}] [AgreementPanel] the index still lacks the mint of ${id}`, error));
                }
            } catch (error) {
                console.warn(`[${new Date().toISOString()}] [AgreementPanel] the mint record of ${id} could not be reconciled`, error);
            }
        }

        // The index's row of a proposed agreement: its status, its chain record and the relay's
        // decisions on it. Read once per open, after Propose and after each chain action; a later
        // render reuses it.
        async function readRemote(agreement, { force = false } = {}) {
            const cid = agreement && agreement.published ? agreement.published.cid : null;
            if (!cid || (!force && state.remote && state.remote.cid === cid)) return;
            const id = agreement.id;
            state.remote = { cid, loading: true, status: null, error: null, onchain: null };
            try {
                const row = await win.AgreementSync.fetchAgreement(cid);
                if (state.id !== id) return;
                const onchain = row.onchain && typeof row.onchain === 'object' ? row.onchain : null;
                state.remote = { cid, loading: false, status: row.status, error: null, onchain };
                reconcileOnchain(id, onchain);
            } catch (error) {
                if (state.id !== id) return;
                console.warn(`[${new Date().toISOString()}] [AgreementPanel] the server status of ${cid} is unavailable`, error);
                state.remote = { cid, loading: false, status: null, error: (error && error.message) || String(error), onchain: null };
            }
            if (win.ProposalApprovalPanel) {
                win.ProposalApprovalPanel.setStatus(id, state.remote.status);
                win.ProposalApprovalPanel.sync(id);
            }
            if (isOpen() && state.id === id) renderPanel();
        }

        // Reads the agreement again and checks it against the map; a newer call wins.
        async function refresh(token = ++state.token) {
            const id = state.id;
            try {
                const agreement = store().get(id);
                if (token !== state.token) return;
                if (!agreement) {
                    log(`${id} is no longer on this device`);
                    close();
                    return;
                }
                state.agreement = agreement;
                state.checking = true;
                state.error = null;
                renderPanel();
                readRemote(agreement);
                syncChain(agreement);
                const check = await checkAgreement(agreement);
                if (token !== state.token) return;
                state.check = check;
                state.checking = false;
                // A comparison of land the designs no longer shape would show the wrong "after".
                if (!check.current && comparing(id)) win.ProposalBeforeAfter.dispose();
                renderPanel();
                log(`${id}: ${check.current ? 'matches the map' : `no longer matches the map (${check.reasons.map(reason => reason.code).join(', ')})`}`);
            } catch (error) {
                if (token !== state.token) return;
                console.error(`[${new Date().toISOString()}] [AgreementPanel] ${id} could not be checked`, error);
                state.error = error && error.message ? error.message : String(error);
                state.checking = false;
                renderPanel();
            }
        }

        // A failed action surfaces as a notice; a write in a secondary tab says where it can be made.
        function report(what, error) {
            console.error(`[${new Date().toISOString()}] [AgreementPanel] ${what}`, error);
            const text = error && error.code === 'secondary-tab'
                ? t('agreement.errors.secondaryTab', 'Another tab holds this city\'s data; agreements can be edited there only.')
                : (error && error.message) || String(error);
            if (typeof win.showEphemeralMessage === 'function') win.showEphemeralMessage(text, 6000, 'error');
        }

        async function edit() {
            const id = state.id;
            try {
                await win.AgreementDialog.open({ agreementId: id });
            } catch (error) {
                report(`editing ${id} failed`, error);
                return;
            }
            if (state.id === id && isOpen()) refresh();
        }

        async function remove() {
            const id = state.id;
            const confirmed = await win.CbDialog.confirm(t('agreement.panel.deleteConfirm', 'Delete this agreement? Its designs stay on the map.'), {
                destructive: true,
                okText: t('agreement.panel.actions.delete', 'Delete'),
                cancelText: t('common.cancel', 'Cancel')
            });
            if (!confirmed || state.id !== id) return;
            try {
                store().remove(id);
            } catch (error) {
                report(`deleting ${id} failed`, error);
                return;
            }
            log(`deleted ${id}`);
            close();
        }

        // Propose (agreement-sync.js): publishes the designs and the agreement, then copies the link.
        async function propose() {
            const id = state.id;
            try {
                const { cid, link } = await win.AgreementSync.publishAgreement(id);
                log(`${id} proposed as ${cid}`);
                state.remote = null;
                if (await win.DesignSync.copyLink(link)) {
                    win.showEphemeralMessage(t('agreement.publish.linkCopied', 'Agreement proposed. Its link is copied.'), 5000, 'success');
                } else {
                    win.showEphemeralMessage(t('agreement.publish.proposedAt', 'Agreement proposed: {{link}}', { link }), 9000, 'success');
                }
            } catch (error) {
                if (error && error.cancelled) return;
                report(`proposing ${id} failed`, error);
            }
            if (state.id === id && isOpen()) refresh();
        }

        async function copyLink() {
            const agreement = state.agreement;
            if (!agreement || !agreement.published) return;
            const link = win.AgreementSync.agreementLink(agreement.published.cid, { city: agreement.city });
            if (await win.DesignSync.copyLink(link)) win.showEphemeralMessage(t('agreement.publish.linkCopiedShort', 'Agreement link copied.'), 3000, 'success');
            else win.showEphemeralMessage(link, 9000, 'info');
        }

        // ---- chain actions -----------------------------------------------------------------------

        const notice = (text, tone = 'success', ms = 5000) => win.showEphemeralMessage(text, ms, tone);
        // A wallet's "user rejected" is the person changing their mind, not a failure.
        const rejectedInWallet = error => !!error && (error.code === 4001 || /user rejected|rejected the request|user denied/i.test(String(error.message || '')));

        // Runs one chain action: the section names its phase and every chain button waits until it
        // ends; the account and the index's row are read again afterwards, whatever happened.
        async function runChain(action, work) {
            if (state.chainBusy) return;
            const id = state.id;
            state.chainBusy = { action, phase: 'preparing' };
            renderPanel();
            const onStatus = ({ state: phase }) => {
                if (state.id !== id || !state.chainBusy || !CHAIN_PHASE[phase]) return;
                state.chainBusy = { action, phase };
                const line = state.panel && state.panel.querySelector('[data-agreement-chain-busy]');
                if (line) line.textContent = CHAIN_PHASE[phase](t);
                else renderPanel();
            };
            try {
                await work(onStatus, phase => onStatus({ state: phase }));
            } catch (error) {
                if (rejectedInWallet(error)) log(`${action} on ${id}: declined in the wallet`);
                else report(`${action} on ${id} failed`, error);
            } finally {
                if (state.id === id) {
                    state.chainBusy = null;
                    const agreement = store().get(id);
                    if (agreement) {
                        state.agreement = agreement;
                        readChain(agreement);
                        readRemote(agreement, { force: true });
                    } else {
                        renderPanel();
                    }
                }
            }
        }

        // What the program fixes at create beyond the agreement itself: the escrow execution needs and
        // the account the escrow is released to (the sponsor's wallet unless another is given).
        // Resolves { requiredLamports, payout } or null when cancelled.
        function askMintTerms(agreement, lens) {
            return new Promise(resolve => {
                const sponsor = agreement.published.sponsor;
                const body = doc.createElement('div');
                body.className = 'agreement-mint';
                body.innerHTML = `<p class="agreement-panel-meta">${esc(t('agreement.chain.mint.intro', 'Minting commits this agreement’s CID to Solana at its sponsor’s address. Its lens attests the decision; executing it then releases the escrow to the payout account.'))}</p>`
                    + '<dl class="agreement-panel-facts">'
                    + `<div><dt>${esc(t('agreement.chain.facts.lens', 'Lens'))}</dt><dd><code title="${esc(lens)}">${esc(shortKey(lens))}</code></dd></div>`
                    + `<div><dt>${esc(t('agreement.chain.facts.deadline', 'Deadline'))}</dt><dd>${esc(agreement.deadline ? format().formatDateTime(agreement.deadline) : t('agreement.chain.noDeadline', 'None'))}</dd></div>`
                    + '</dl>'
                    + `<label class="agreement-mint__field"><span>${esc(t('agreement.chain.mint.required', 'Escrow needed to execute (SOL)'))}</span>`
                    + '<input type="text" inputmode="decimal" autocomplete="off" data-agreement-mint-required value="0"></label>'
                    + `<p class="agreement-panel-hint">${esc(t('agreement.chain.mint.requiredHint', 'Execution waits until the escrow holds this much; 0 needs none. The sponsor funds the escrow after minting.'))}</p>`
                    + `<label class="agreement-mint__field"><span>${esc(t('agreement.chain.mint.payout', 'Payout account'))}</span>`
                    + `<input type="text" autocomplete="off" spellcheck="false" data-agreement-mint-payout value="${esc(sponsor)}"></label>`
                    + `<p class="agreement-panel-hint">${esc(t('agreement.chain.mint.payoutHint', 'Receives the whole escrow when the agreement executes.'))}</p>`
                    + '<p class="agreement-panel-note agreement-panel-note--danger" role="alert" data-agreement-mint-error hidden></p>';
                let settled = false;
                const finish = value => {
                    if (settled) return;
                    settled = true;
                    resolve(value);
                };
                const dialog = win.CbDialog.open({
                    title: t('agreement.chain.mint.title', 'Mint the agreement'),
                    size: 'sm',
                    className: 'agreement-mint-dialog',
                    body,
                    onClose: () => finish(null),
                    actions: [
                        { id: 'cancel', label: t('common.cancel', 'Cancel'), role: 'secondary' },
                        {
                            id: 'mint', label: t('agreement.chain.actions.mint', 'Mint'), role: 'primary', keepOpen: true,
                            onClick: api => {
                                const error = body.querySelector('[data-agreement-mint-error]');
                                const typed = format().parseDecimal(body.querySelector('[data-agreement-mint-required]').value);
                                const requiredLamports = typed === null ? 0n : bridgeApi().lamportsFromSol(typed, { allowZero: true });
                                const payout = body.querySelector('[data-agreement-mint-payout]').value.trim();
                                const problem = requiredLamports === null
                                    ? t('agreement.chain.errors.amount', 'Enter an amount of SOL, such as 0.5.')
                                    : (!win.LensCore.isBase58Pubkey(payout) ? t('agreement.chain.errors.payout', 'The payout account must be a Solana address.') : null);
                                if (problem) {
                                    error.textContent = problem;
                                    error.hidden = false;
                                    return;
                                }
                                finish({ requiredLamports, payout });
                                api.close('mint');
                            }
                        }
                    ]
                });
                if (!dialog) finish(null);
            });
        }

        // Mint (the sponsor): create the account, then mirror it into the index and keep it here.
        async function mint() {
            const id = state.id;
            const agreement = state.agreement;
            if (!agreement || !agreement.published) return;
            const lens = mintLensOf(agreement);
            const terms = await askMintTerms(agreement, lens);
            if (!terms || state.id !== id) return;
            await runChain('mint', async (onStatus, phase) => {
                const minted = await win.AgreementBridge.mint({ agreement, lens, requiredLamports: terms.requiredLamports, payout: terms.payout, onStatus });
                phase('indexing');
                try {
                    await win.AgreementSync.recordOnchain(id, { chain: 'solana', cluster: minted.cluster, account: minted.account, signature: minted.signature });
                    notice(t('agreement.chain.minted', 'Agreement minted.'));
                } catch (error) {
                    if (!error || !error.kept) throw error;
                    notice(t('agreement.chain.mintedNotIndexed', 'Agreement minted, but the server did not record it: {{reason}}', { reason: error.message }), 'warning', 9000);
                }
            });
        }

        // Propose again with the connected wallet as the sponsor: a new agreement, opened in its place.
        async function repropose() {
            const id = state.id;
            try {
                const { id: copyId, cid, link } = await win.AgreementSync.proposeAgain(id);
                log(`${id} proposed again as ${copyId} (${cid})`);
                if (await win.DesignSync.copyLink(link)) notice(t('agreement.chain.reproposed', 'Proposed again as a new agreement. Its link is copied.'));
                else notice(t('agreement.publish.proposedAt', 'Agreement proposed: {{link}}', { link }), 'success', 9000);
                await open(copyId);
            } catch (error) {
                if (error && error.cancelled) return;
                report(`proposing ${id} again failed`, error);
            }
        }

        // Fund (the sponsor): an amount prompt, proposing what the escrow still lacks.
        async function fund() {
            const id = state.id;
            const agreement = state.agreement;
            const value = state.chain && state.chain.value;
            if (!agreement || !value) return;
            const lacking = value.requiredLamports > value.escrowLamports ? value.requiredLamports - value.escrowLamports : 0n;
            const readLamports = text => {
                const typed = format().parseDecimal(text);
                return typed === null ? null : bridgeApi().lamportsFromSol(typed);
            };
            const answer = await win.CbDialog.prompt(t('agreement.chain.fundPrompt', 'How much SOL should the escrow receive from the sponsor’s wallet?'), {
                title: t('agreement.chain.actions.fund', 'Fund'),
                defaultValue: lacking > 0n ? format().formatNumber(bridgeApi().solOf(lacking), { maxFractionDigits: 9 }) : '',
                placeholder: format().formatNumber(0.5, { maxFractionDigits: 1 }),
                okText: t('agreement.chain.actions.fund', 'Fund'),
                validate: text => readLamports(text) !== null
            });
            if (answer === null || state.id !== id) return;
            const lamports = readLamports(answer);
            await runChain('fund', async onStatus => {
                await win.AgreementBridge.fund({ agreement, lamports, onStatus });
                notice(t('agreement.chain.funded', 'The escrow received {{amount}}.', { amount: solText(lamports) }));
            });
        }

        // Record decision (anyone): the lens's attestation its member lists (readChain).
        async function attest() {
            const agreement = state.agreement;
            const attestation = state.chain && state.chain.attestation;
            if (!agreement || !attestation) return;
            await runChain('attest', async onStatus => {
                await win.AgreementBridge.attest({ agreement, attestation, onStatus });
                notice(t('agreement.chain.attested', 'Decision recorded: the rule is satisfied.'));
            });
        }

        // Execute (anyone): the escrow goes to the payout account.
        async function execute() {
            const agreement = state.agreement;
            if (!agreement) return;
            await runChain('execute', async onStatus => {
                await win.AgreementBridge.execute({ agreement, onStatus });
                notice(t('agreement.chain.executed', 'Agreement executed: the escrow went to its payout account.'));
            });
        }

        // Cancel (the sponsor): ends the agreement and refunds the escrow.
        async function cancel() {
            const id = state.id;
            const agreement = state.agreement;
            if (!agreement) return;
            const confirmed = await win.CbDialog.confirm(t('agreement.chain.cancelConfirm', 'Cancel this agreement on chain? It ends for good and the escrow returns to the sponsor.'), {
                destructive: true,
                okText: t('agreement.chain.actions.cancel', 'Cancel'),
                cancelText: t('agreement.chain.keep', 'Keep it')
            });
            if (!confirmed || state.id !== id) return;
            await runChain('cancel', async onStatus => {
                await win.AgreementBridge.cancel({ agreement, onStatus });
                notice(t('agreement.chain.cancelled', 'Agreement cancelled; the escrow returned to the sponsor.'));
            });
        }

        // Expire (anyone, after the deadline): ends the agreement and refunds the escrow.
        async function expire() {
            const agreement = state.agreement;
            if (!agreement) return;
            await runChain('expire', async onStatus => {
                await win.AgreementBridge.expire({ agreement, onStatus });
                notice(t('agreement.chain.expired', 'Agreement expired; the escrow returned to the sponsor.'));
            });
        }

        function bet() {
            const id = state.id;
            Promise.resolve().then(() => win.AgreementBets.open(id)).catch(error => report(`the bet on ${id} could not be opened`, error));
        }

        // A design's own details take the right dock, so this panel steps aside.
        function selectDesign(proposalId) {
            if (typeof win.selectAndHighlightProposal !== 'function') throw new Error('selectAndHighlightProposal is not loaded.');
            close();
            win.selectAndHighlightProposal(proposalId, null, true, true);
        }

        function onPanelClick(event) {
            const design = event.target.closest('[data-agreement-design]');
            if (design) { selectDesign(design.getAttribute('data-agreement-design')); return; }
            const action = event.target.closest('[data-agreement-action]');
            if (!action || action.disabled) return;
            switch (action.getAttribute('data-agreement-action')) {
                case 'close': close(); break;
                case 'compare': win.BusyControl.track(action, () => win.toggleAgreementBeforeAfter(state.id)); break;
                case 'propose': win.BusyControl.track(action, () => propose()); break;
                case 'link': copyLink(); break;
                case 'mint': mint(); break;
                case 'repropose': win.BusyControl.track(action, () => repropose()); break;
                case 'fund': fund(); break;
                case 'attest': attest(); break;
                case 'execute': execute(); break;
                case 'cancel': cancel(); break;
                case 'expire': expire(); break;
                case 'bet': bet(); break;
                case 'edit': edit(); break;
                case 'delete': remove(); break;
                default: break;
            }
        }

        function onKeyDown(event) {
            if (event.key !== 'Escape' || event.defaultPrevented || !isOpen()) return;
            if (typeof win.isEditableTarget === 'function' && win.isEditableTarget(event.target)) return;
            if (typeof win.isAnyModalOpen === 'function' && win.isAnyModalOpen()) return;
            event.preventDefault();
            close();
        }

        // Saving, deleting or clearing this agreement, here or in the dialog, redraws the panel.
        function onStoreChange(change) {
            if (!isOpen() || !state.id) return;
            if (change && change.type !== 'clear' && idOf(change.id) !== state.id) return;
            refresh();
        }

        // Applying, unapplying or editing a design changes the ground the agreement was checked
        // against, so every fabric commit checks it again while the panel is open.
        function onFabricChange() {
            if (!isOpen() || !state.id) return;
            refresh();
        }

        // Connecting, switching or disconnecting the Solana wallet changes who may act on chain.
        function onWalletChange() {
            if (!isOpen() || !state.agreement || !state.agreement.published) return;
            renderPanel();
        }

        function wire() {
            if (state.wired) return;
            doc.addEventListener('keydown', onKeyDown);
            store().subscribe(onStoreChange);
            if (win.LiveParcelFabric && typeof win.LiveParcelFabric.subscribe === 'function') win.LiveParcelFabric.subscribe(onFabricChange);
            if (win.solanaWalletManager && typeof win.solanaWalletManager.on === 'function') win.solanaWalletManager.on('stateChanged', onWalletChange);
            state.wired = true;
        }

        // The agreement takes the right dock: the sheets, a parcel's panel and a design's panel make way.
        function makeWay() {
            if (win.MapShell && typeof win.MapShell.closeSheets === 'function') win.MapShell.closeSheets();
            win.ClickStack?.close({ keepPanels: true });
            if (doc.getElementById('parcel-info-panel')?.classList.contains('visible') && typeof win.hideParcelInfoPanel === 'function') win.hideParcelInfoPanel();
            if (doc.getElementById('proposal-details-panel')?.classList.contains('visible') && typeof win.hideProposalDetailsPanel === 'function') win.hideProposalDetailsPanel(true);
        }

        async function open(id) {
            const agreementId = idOf(id);
            if (!agreementId) throw new Error('AgreementPanel.open: an agreement id is required');
            wire();
            const token = ++state.token;
            // Another agreement's before / after does not belong to this one.
            if (state.id && state.id !== agreementId && comparing(state.id)) win.ProposalBeforeAfter.dispose();
            if (state.id !== agreementId) {
                state.remote = null;
                state.chain = null;
                state.chainBusy = null;
                state.chainToken += 1;
            }
            state.id = agreementId;
            state.agreement = null;
            state.check = null;
            state.error = null;
            state.checking = true;
            makeWay();
            renderPanel();
            await refresh(token);
        }

        // The before / after lives and dies with the panel.
        function close() {
            state.token += 1;
            if (comparing(state.id)) win.ProposalBeforeAfter.dispose();
            state.id = null;
            state.agreement = null;
            state.check = null;
            state.error = null;
            state.checking = false;
            state.remote = null;
            state.chain = null;
            state.chainBusy = null;
            state.chainToken += 1;
            if (state.panel) state.panel.classList.remove('visible');
            doc.body.classList.remove('agreement-panel-open');
        }

        return { open, close, isOpen, current: () => state.id };
    }

    return {
        titleOf, statusOf, landSummary, allocationLines, ledgerRows, ruleSummary, ruleShort, designRows, groundIds, holdersLine,
        statusHtml, actionsHtml, remoteStatusOf, publishedHtml, designsHtml, landHtml, allocationHtml, ledgerHtml, ruleHtml,
        shortKey, chainStatusText, mintReadiness, isBinding, chainHtml, nonBindingChainHtml, browserPanel
    };
});
