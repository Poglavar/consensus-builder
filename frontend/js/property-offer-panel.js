// One property offer as people follow it: what is sold, the price, where it stands in plain words,
// who holds the asset according to the reader's own lens, both sides' lens members with who has
// confirmed, and only the next steps the connected wallet can take. Chain state is re-read on open,
// after every action and on Refresh.
(function (root) {
    'use strict';
    const t = (key, fallback, params = {}) => {
        const fullKey = `propertyOffer.${key}`, value = root.i18n?.t?.(fullKey, params);
        return value && value !== fullKey ? value : String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => params[name] ?? match);
    };
    const tt = (key, fallback, params = {}) => { const value = root.i18n?.t?.(key, params); return value && value !== key ? value : String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, n) => params[n] ?? m); };
    const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
    const D = () => root.PropertyOfferDialog;
    const wallet = () => root.PropertyOfferSolanaBridge?.connectedWallet?.() || null;
    const keyEl = (key, mine) => key ? root.KeyLabel.element(key, { you: key === mine, t: tt }) : el('span', 'property-offer-panel__none', t('notYet', 'Not yet'));
    const past = record => Date.parse(record.content.expiresAt) <= Date.now();

    /** The offer's state in words, from the chain account (or the record when not minted yet). */
    function stateText(record, chain) {
        if (!record.published) return t('states.draft', 'Draft on this device');
        if (!chain) return t('states.unminted', 'Published, not yet on Solana');
        const lensesLeft = [chain.buyerLens, chain.sellerLens].filter(lens => !lens.met);
        switch (chain.status) {
            case 'Open': return past(record) ? t('states.openExpired', 'Expired without a taker') : record.content.direction === 'sell' ? t('states.openSell', 'For sale: waiting for a buyer') : t('states.openBuy', 'Wanted: waiting for the holder to accept');
            case 'Committed':
                if (past(record)) return t('states.committedExpired', 'Deadline passed before the lens confirmed; the buyer can take the money back');
                if (!lensesLeft.length) return t('states.ready', 'Confirmed: ready to pay out');
                return t('states.waitingLens', 'Waiting for lens members: {{done}} of {{needed}} confirmed', {
                    done: chain.buyerLens.confirmed.length + chain.sellerLens.confirmed.length, needed: chain.buyerLens.threshold + chain.sellerLens.threshold });
            case 'Settled': return t('states.settled', 'Sold: the money was paid out');
            case 'Cancelled': return t('states.cancelled', 'Withdrawn by its maker');
            case 'Expired': return t('states.expired', 'Expired; any escrow went back to the buyer');
            default: return chain.status;
        }
    }

    function lensSection(title, lens, mine, emptyText) {
        const section = el('section', 'property-offer-panel__section');
        section.append(el('h4', '', title));
        if (!lens || !lens.members.length) { section.append(el('p', 'sheet-note', emptyText)); return section; }
        const badge = el('div', 'lens-badge'); badge.setAttribute('role', 'img');
        badge.setAttribute('aria-label', t('lensBadge', '{{done}} of {{needed}} needed have confirmed', { done: lens.confirmed.length, needed: lens.threshold }));
        lens.members.forEach(member => badge.append(el('span', `lens-badge__segment${lens.confirmed.includes(member) ? ' is-confirmed' : ''}`)));
        section.append(badge);
        const list = el('ul', 'property-offer-panel__members');
        for (const member of lens.members) {
            const item = el('li'); item.append(keyEl(member, mine), el('span', 'property-offer-panel__mark', lens.confirmed.includes(member) ? t('confirmed', 'Confirmed') : t('waiting', 'Waiting')));
            list.append(item);
        }
        section.append(list);
        if (lens.threshold < lens.members.length) section.append(el('p', 'sheet-note', t('threshold', '{{needed}} of these {{count}} lens members must confirm.', { needed: lens.threshold, count: lens.members.length })));
        return section;
    }

    /** "According to your lens": what the reader's lens preference says about who holds the asset. */
    async function holderSection(section, record, mine) {
        const members = (root.LensPicker?.getEntries?.() || []).map(entry => entry.address).filter(Boolean);
        section.replaceChildren(el('h4', '', t('yourLens', 'According to your lens')));
        if (!members.length) { section.append(el('p', 'sheet-note', t('noLens', 'You have not chosen whom you trust yet. Choose lens members to see who holds this.'))); return; }
        const p = el('p', 'property-offer-panel__holder', t('reading', 'Reading Solana…')); section.append(p);
        try {
            const view = await root.PropertyOfferSolanaBridge.lensView(members, record.content.asset);
            p.replaceChildren();
            if (view.holder) p.append(el('span', '', t('holderIs', 'Held by ')), keyEl(view.holder, mine), el('span', 'sheet-note', ` (${t('statedBy', '{{count}} of your lens members state it', { count: view.stating })})`));
            else if (view.conflict) { p.append(el('span', '', t('holderConflict', 'Your lens members disagree: '))); view.conflict.forEach(k => p.append(keyEl(k, mine))); }
            else p.textContent = t('holderUnknown', 'None of your lens members states who holds this.');
        } catch (error) { p.textContent = error.message; }
    }

    function open(idOrRecord, { error = null } = {}) {
        let record = typeof idOrRecord === 'string' ? root.PropertyOfferStore?.get?.(idOrRecord) : idOrRecord;
        if (!record) throw new Error(t('errors.missing', 'This property offer is not held on this device.'));
        const body = el('div', 'property-offer-panel');
        let chain = null, chainError = error, reading = false, roles = [];
        let dialog;
        const render = () => {
            const c = record.content, mine = wallet();
            body.replaceChildren();
            const head = el('div', 'property-offer-panel__head');
            head.append(el('h3', '', `${c.direction === 'sell' ? t('forSale', 'For sale') : t('wanted', 'Wanted')}: ${D().assetLabel(c.asset)}`));
            const link = el('a', 'cb-link', c.asset.kind === 'flat' ? t('viewFlat', 'View the flat in X-ray') : t('viewPlot', 'Show the plot on the map'));
            link.href = D().assetHref(c.asset, c.city); head.append(link);
            if (c.title) head.append(el('p', 'sheet-note', c.title));
            body.append(head);
            const facts = el('dl', 'property-offer-panel__facts');
            const row = (label, value) => { const r = el('div'); const dd = el('dd'); dd.append(value instanceof Node ? value : document.createTextNode(String(value))); r.append(el('dt', '', label), dd); facts.append(r); };
            row(t('fields.price', 'Price'), D().money(c.price, c.currency));
            row(t('fields.status', 'Where it stands'), reading && !chain ? t('reading', 'Reading Solana…') : stateText(record, chain));
            row(t('fields.deadline', 'Valid until'), new Date(c.expiresAt).toLocaleString(root.i18n?.getLanguage?.() || undefined));
            row(t('fields.seller', 'Seller'), keyEl(chain?.seller || (c.direction === 'sell' ? c.proposer : null), mine));
            row(t('fields.buyer', 'Buyer'), keyEl(chain?.buyer || (c.direction === 'buy' ? c.proposer : null), mine));
            if (chain && chain.escrow > 0n) row(t('fields.escrow', 'In escrow'), D().money(chain.escrow.toString(), c.currency));
            body.append(facts);
            const holder = el('section', 'property-offer-panel__section'); body.append(holder); void holderSection(holder, record, mine);
            const buyerLens = chain ? chain.buyerLens : (c.direction === 'buy' ? { ...c.lens, confirmed: [] } : null);
            const sellerLens = chain ? chain.sellerLens : (c.direction === 'sell' ? { ...c.lens, confirmed: [] } : null);
            body.append(lensSection(t('buyerLens', 'Buyer’s lens: confirms the seller holds it'), buyerLens, mine, t('buyerLensOpen', 'The buyer names it when buying.')));
            body.append(lensSection(t('sellerLens', 'Seller’s conditions: qualify the buyer'), sellerLens, mine, t('sellerLensNone', 'None: any buyer may take it.')));
            const status = el('p', 'property-offer-panel__status'); status.setAttribute('role', 'status'); status.textContent = chainError || ''; body.append(status);
            const actions = el('div', 'cb-actions property-offer-panel__actions');
            const button = (label, run, primary = false) => {
                const b = el('button', `btn${primary ? ' btn-primary' : ''}`, label); b.type = 'button';
                b.addEventListener('click', () => root.BusyControl.track(b, async () => {
                    const result = await run(s => { status.textContent = D().progressText(s.state); });
                    if (result?.content) record = result;
                    status.textContent = result?.executed ? t('paidOut', 'Confirmed and paid out.') : t('saved', 'Done.');
                    await readChain();
                }).catch(err => { if (err.record) record = err.record; status.textContent = err.message; }));
                actions.append(b);
            };
            const bridge = root.PropertyOfferSolanaBridge;
            if (!mine) {
                const connect = el('button', 'btn', tt('wallet.connect', 'Connect wallet')); connect.type = 'button';
                connect.addEventListener('click', () => root.BusyControl.track(connect, async () => { await root.walletManager.openConnectorModal({ chain: 'solana' })?.dialog.closed; await readChain(); }));
                actions.append(connect);
            } else if (!chain && record.published === null) {
                button(t('mint', 'Put it on Solana'), onStatus => root.PropertyOfferSync.mint(record, { onStatus }), true);
            } else if (!chain && c.proposer === mine) {
                button(t('mint', 'Put it on Solana'), onStatus => bridge.mint(record, { onStatus }), true);
            } else if (chain) {
                const open = chain.status === 'Open' && !past(record), committed = chain.status === 'Committed' && !past(record);
                if (open && mine !== chain.maker) {
                    const take = el('button', 'btn btn-primary', c.direction === 'sell' ? t('buyThis', 'Buy') : t('acceptBid', 'Accept this offer')); take.type = 'button';
                    take.addEventListener('click', () => { dialog.close(); D().take(record); }); actions.append(take);
                }
                if (open && mine === chain.maker) button(t('cancelOffer', 'Withdraw offer'), onStatus => bridge.cancel(record, { onStatus }));
                for (const entry of committed ? roles : []) {
                    if (entry.confirmed) continue;
                    const label = entry.role === 0 ? t('confirmHolds', 'Confirm the seller holds it') : t('confirmBuyer', 'Confirm the buyer qualifies');
                    button(label, onStatus => bridge.confirm(record, { role: entry.role, onStatus }), true);
                    if (entry.role === 0 && entry.view && entry.view.holder !== chain.seller) {
                        status.textContent = entry.view.holder ? t('memberViewOther', 'Your statements name another holder; you cannot confirm this sale.') : t('memberViewNone', 'You have not stated who holds this; state the first holder before confirming.');
                    }
                }
                if (committed && chain.buyerLens.met && chain.sellerLens.met) button(t('execute', 'Pay out'), onStatus => bridge.execute(record, { onStatus }), true);
                if (['Open', 'Committed'].includes(chain.status) && past(record) && (chain.escrow > 0n || mine === chain.maker)) button(t('expire', 'Return the escrow'), onStatus => bridge.expire(record, { onStatus }));
            }
            const share = el('button', 'btn btn-quiet', t('share', 'Copy link')); share.type = 'button';
            share.disabled = !record.published;
            share.addEventListener('click', () => root.BusyControl.track(share, async () => { await root.navigator.clipboard.writeText(root.PropertyOfferSync.link(record.published.cid, { city: c.city })); status.textContent = t('linkCopied', 'Link copied.'); }));
            const refresh = el('button', 'btn btn-quiet', t('refresh', 'Refresh')); refresh.type = 'button'; refresh.disabled = !record.published;
            refresh.addEventListener('click', () => root.BusyControl.track(refresh, readChain));
            actions.append(share, refresh);
            body.append(actions);
            if (chain) {
                const account = el('a', 'cb-link cb-link--external property-offer-panel__account', t('onSolana', 'See it on Solana explorer'));
                account.href = `https://explorer.solana.com/address/${encodeURIComponent(chain.address)}?cluster=devnet`; account.target = '_blank'; account.rel = 'noopener noreferrer';
                body.append(account);
            }
        };
        async function readChain() {
            if (!record.published?.cid) { render(); return; }
            reading = true; chainError = null; render();
            try {
                const result = await root.PropertyOfferSolanaBridge.memberActions(record);
                chain = result.chain; roles = result.roles;
                if (chain && record.onchain?.status !== chain.status.toLowerCase()) { try { record = await root.PropertyOfferSolanaBridge.refresh(record); } catch (err) { if (err.record) record = err.record; } }
            } catch (err) { chainError = err.message || String(err); }
            reading = false; render();
        }
        root.KeyLabel.loadNames().then(render);
        const unsubscribe = root.solanaWalletManager?.on?.('stateChanged', () => void readChain());
        dialog = root.CbDialog.open({ title: t('details', 'Offer'), size: 'md', className: 'property-offer-dialog', body, actions: [], onClose: () => unsubscribe?.() });
        void readChain();
        return dialog;
    }
    root.PropertyOfferPanel = Object.freeze({ open, stateText });
})(typeof window !== 'undefined' ? window : globalThis);
