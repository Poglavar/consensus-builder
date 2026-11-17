// EVM agreement betting, reached from the agreement panel. No signing on open or quote.
(function (win) {
    'use strict';
    if (!win?.document) return;
    const text = (key, fallback) => {
        const value = win.i18n?.t?.(`evmMarkets.${key}`);
        return value && value !== `evmMarkets.${key}` ? value : fallback;
    };
    const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
    async function open(agreement) {
        const ref = win.EvmAgreementBridge.onchainRef(agreement);
        if (!ref) throw new Error('An EVM agreement is required.');
        const doc = win.document, body = doc.createElement('div');
        body.style.cssText = 'display:grid;gap:12px;min-width:0;overflow-wrap:anywhere';
        const summary = doc.createElement('p');
        const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        const receipt = doc.createElement('a'); receipt.target = '_blank'; receipt.rel = 'noopener noreferrer'; receipt.hidden = true;
        const controls = [], fields = [];
        let snapshot = null, quoted = null, busy = false;
        function field(label, value, options) {
            const wrap = doc.createElement('label'); wrap.textContent = label;
            wrap.style.cssText = 'display:grid;gap:4px';
            const input = doc.createElement(options ? 'select' : 'input');
            input.setAttribute('aria-label', label);
            if (options) options.forEach(([v, title]) => { const option = doc.createElement('option'); option.value = v; option.textContent = title; input.append(option); });
            else { input.type = 'text'; input.inputMode = 'decimal'; }
            input.value = value; input.style.cssText = 'width:100%;box-sizing:border-box;min-width:0';
            input.addEventListener('input', () => { quoted = null; update(); });
            wrap.append(input); body.append(wrap); fields.push(input); return input;
        }
        function button(label, work) {
            const b = doc.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = label;
            b.addEventListener('click', () => run(b, work)); controls.push(b); body.append(b); return b;
        }
        const wallet = () => {
            const state = win.walletManager?.getState?.();
            return state?.status === 'connected' && String(Number(state.chainId)) === String(Number(ref.chainId)) ? state.accounts?.[0] : null;
        };
        const format = n => win.ethers.formatUnits(n || 0n, 6);
        const units = input => {
            if (!/^\d+(\.\d{1,6})?$/.test(input.value.trim())) throw new Error(text('amountError', 'Use a positive amount with up to six decimal places.'));
            return win.EvmMarkets.atomic(win.ethers.parseUnits(input.value.trim(), 6));
        };
        const client = signing => win.EvmMarkets.browser(win, ref.chainId, signing);
        body.append(summary, status, receipt);
        const side = field(text('side', 'Outcome'), 'yes', [['yes', text('yes', 'Yes')], ['no', text('no', 'No')]]);
        const action = field(text('action', 'Trade'), 'buy', [['buy', text('buy', 'Buy')], ['sell', text('sell', 'Sell')]]);
        const shares = field(text('shares', 'Shares'), '1');
        const quoteButton = button(text('quote', 'Get quote'), async () => {
            const adapter = await client(false);
            quoted = await adapter.quote({ key: ref.account, side: side.value, shares: units(shares), action: action.value });
            status.textContent = `${text('quote', 'Get quote')}: ${format(quoted.amountAtomic)} USDC · ${format(quoted.shares)} ${text('shares', 'Shares')}`;
        });
        const tradeButton = button(text('confirmTrade', 'Confirm trade'), async () => {
            const quote = quoted; if (!quote) return;
            // Freeze the displayed quote: an approval never grants a larger trade limit.
            quoted = null;
            const result = await (await client(true)).trade({ ...quote, limit: quote.amountAtomic, onStatus });
            await confirmed(result);
        });
        const liquidity = field(text('liquidity', 'Liquidity b (USDC)'), '5');
        const funding = field(text('funding', 'Maximum seed (USDC)'), '3.5');
        const openButton = button(text('open', 'Open market'), async () => confirmed(await (await client(true)).open({
            key: ref.account, liquidity: units(liquidity), maxFunding: units(funding), onStatus })));
        const resolveButton = button(text('resolve', 'Resolve market'), async () => confirmed(await (await client(true)).resolve({ key: ref.account, onStatus })));
        const claimButton = button(text('claim', 'Claim winnings'), async () => confirmed(await (await client(true)).claim({ key: ref.account, onStatus })));
        const reclaimButton = button(text('reclaim', 'Reclaim seed'), async () => confirmed(await (await client(true)).reclaim({ key: ref.account, onStatus })));
        const refreshButton = button(text('refresh', 'Refresh'), refresh);
        function onStatus(event) { status.textContent = text(event.state, event.state); }
        async function confirmed(result) {
            const url = result.signature && win.EvmAdapter.explorerUrl(ref.chainId, { tx: result.signature });
            receipt.hidden = !url; if (url) { receipt.href = url; receipt.textContent = text('transaction', 'View transaction'); }
            await refresh(); status.textContent = text('confirmed', 'Confirmed');
        }
        async function refresh() {
            quoted = null; status.textContent = '';
            snapshot = await (await client(false)).read(ref.account, wallet());
            summary.textContent = `Chain ${ref.chainId} · ${snapshot.agreementStatus} · ${snapshot.marketAddress ? `${snapshot.resolved ? snapshot.outcome.toUpperCase() : `${(snapshot.chanceYes * 100).toFixed(1)}% YES`} · ${text('shares', 'Shares')}: ${format(snapshot.positions.yes)} YES / ${format(snapshot.positions.no)} NO` : text('noMarket', 'No market yet')} · USDC: ${snapshot.balanceAtomic === null ? '—' : format(snapshot.balanceAtomic)}`;
        }
        function update() {
            const who = wallet(), sponsor = same(who, snapshot?.sponsor), hasMarket = !!snapshot?.marketAddress;
            controls.forEach(b => { b.disabled = busy; }); fields.forEach(f => { f.disabled = busy; });
            quoteButton.disabled = busy || !snapshot?.tradable;
            tradeButton.disabled = busy || !who || !quoted;
            openButton.disabled = busy || !sponsor || hasMarket || snapshot?.agreementStatus !== 'active';
            openButton.hidden = hasMarket; openButton.style.display = hasMarket ? 'none' : '';
            reclaimButton.hidden = !sponsor; reclaimButton.style.display = sponsor ? '' : 'none';
            resolveButton.disabled = busy || !who || !snapshot?.canResolve;
            claimButton.disabled = busy || !who || !snapshot?.resolved || !(snapshot.positions.yes || snapshot.positions.no);
            reclaimButton.disabled = busy || !sponsor || !hasMarket || snapshot.agreementStatus === 'active' || snapshot.reclaimed;
            for (const input of [liquidity, funding]) { input.parentElement.hidden = hasMarket; input.parentElement.style.display = hasMarket ? 'none' : 'grid'; }
        }
        async function run(control, work) {
            if (busy) return;
            busy = true; update(); status.textContent = text('preparing', 'Preparing');
            try { await win.BusyControl.track(control, work); }
            catch (error) { quoted = null; status.textContent = error.shortMessage || error.message; }
            finally { busy = false; update(); if (control.isConnected) (control.disabled ? refreshButton : control).focus({ preventScroll: true }); }
        }
        win.CbDialog.open({ title: `${text('title', 'Agreement market')} · ${agreement.title || agreement.cid || ref.account}`, body, size: 'md',
            actions: [{ id: 'close', label: text('close', 'Close') }] });
        await run(refreshButton, refresh);
    }
    win.EvmMarketDialog = Object.freeze({ open });
})(typeof window !== 'undefined' ? window : null);
