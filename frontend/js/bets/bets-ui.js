// Small shared betting controls: asset choice, play-money balance and plain-language trade status.
// All presentation uses the existing semantic controls and css/bets-sheet.css.
(function (root) {
    'use strict';
    if (!root?.document) return;
    const doc = root.document;
    function track(name, properties) {
        root.BetsTelemetry?.track(name, { asset: root.BetsTrading.asset(), entryPoint: 'account', ...properties });
    }
    function t(key, fallback, params = {}) {
        const translated = root.i18n?.t(key, params);
        const text = translated && translated !== key ? translated : fallback;
        return String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => params[key] ?? match);
    }
    function el(tag, className, text) {
        const node = doc.createElement(tag); if (className) node.className = className;
        if (text !== undefined) node.textContent = text; return node;
    }
    function money(amount, asset = root.BetsTrading.asset()) {
        return asset === 'points' ? t('bets.trade.pointsAmount', '{{amount}} points', { amount }) : `${amount} USDC`;
    }
    const shares = amount => t('bets.trade.sharesAmount', '{{amount}} shares', { amount });
    // The cutoff is a whole-second chain timestamp. Show its timezone wherever a trade names it.
    const deadline = value => {
        const date = new Date(value);
        return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '';
    };
    const price = row => row.chanceYes === null ? t('bets.row.closed', 'Not open for bets')
        : t('bets.trade.yesPrice', 'YES price {{amount}}', { amount: money(String(row.chanceYes / 100), row.asset) });
    function errorText(error) {
        const key = {
            CONFIRMATION_UNKNOWN: ['confirmationUnknown', 'Confirmation is pending. Check the receipt before retrying.'],
            POINTS_PENDING: ['confirmationUnknown', 'Confirmation is pending. Check the receipt before retrying.'],
            STALE_QUOTE: ['staleQuote', 'The price changed. Review the updated quote before submitting again.'],
            SLIPPAGE_EXCEEDED: ['staleQuote', 'The price changed. Review the updated quote before submitting again.'],
            INSUFFICIENT_BALANCE: ['insufficientBalance', 'Your balance is too low for this trade.'],
            INSUFFICIENT_USDC: ['insufficientUsdc', 'This wallet needs devnet USDC. Use the test-money faucet.'],
            INSUFFICIENT_SOL: ['insufficientSol', 'This wallet needs devnet SOL for transaction fees.'],
            MARKET_IS_CLOSED: ['closed', 'Trading has closed for this agreement.'],
            MARKET_CLOSED: ['closed', 'Trading has closed for this agreement.'],
            WRONG_NETWORK: ['wrongNetwork', 'Switch your wallet to Solana devnet.'],
            WALLET_NOT_CONNECTED: ['connectWallet', 'Connect a wallet to use devnet USDC.'],
            AGREEMENT_INSIDERS_CANNOT_TRADE: ['insider', 'The agreement sponsor and its verifier cannot trade this bet.'],
            INSIDER_TRADE: ['insider', 'The agreement sponsor and its verifier cannot trade this bet.']
        }[error?.code];
        if (key) return t(`bets.trade.${key[0]}`, key[1]);
        return t('bets.trade.failed', 'The action could not be completed. Refresh your balance before trying again.');
    }
    function statusText(item) {
        const words = {
            preparing: ['preparing', 'Preparing…'], awaiting_signature: ['sign', 'Confirm in your wallet…'],
            submitted: ['submitted', 'Waiting for confirmation…'], confirmed: ['confirmed', 'Confirmed']
        }[item?.state];
        return words ? t(`bets.trade.${words[0]}`, words[1]) : '';
    }
    function assetControl() {
        const trading = root.BetsTrading;
        const selected = trading.asset();
        const section = el('section', 'bets-account');
        const label = el('label', 'bets-account__asset');
        label.append(el('span', null, t('bets.trade.playMoney', 'Play money')));
        const select = el('select', 'bets-asset-select');
        select.setAttribute('data-bets-asset', '');
        [['points', t('bets.trade.pointsChoice', 'Points · no wallet')], ['devnet-usdc', t('bets.trade.usdcChoice', 'Devnet USDC · wallet')]]
            .forEach(([value, text]) => { const option = el('option', null, text); option.value = value; select.append(option); });
        select.value = selected;
        select.addEventListener('change', () => { trading.setAsset(select.value); track('asset_select', { asset: select.value }); });
        label.append(select); section.append(label);
        const note = el('p', 'bets-account__note', selected === 'points'
            ? t('bets.trade.pointsIntro', 'Start with 1,000 non-transferable points. Points have no cash value.')
            : t('bets.trade.usdcIntro', 'Devnet USDC is test money with no cash value. Prices and positions are separate from points.'));
        section.append(note);
        if (trading.simulationRun()) section.append(el('p', 'bets-account__simulation', t('bets.trade.simulated', 'Simulated test activity · excluded from public standings')));
        const balance = el('p', 'bets-account__balance');
        balance.setAttribute('aria-live', 'polite'); section.append(balance);
        // The line holds a spinner while the balance is read, so the controls below do not move when it lands.
        root.BusyControl.track(balance, trading.readStakeBalance()).then(value => {
            if (!section.isConnected || selected !== trading.asset()) return;
            balance.textContent = value === null ? t('bets.trade.connectWallet', 'Connect a wallet to use devnet USDC.')
                : t('bets.trade.balance', 'Available: {{amount}}', { amount: money(root.BetsModel.formatAtomic(value), selected) });
        }).catch(() => { if (balance.isConnected) balance.textContent = t('bets.trade.balanceUnavailable', 'Balance unavailable. Try again before trading.'); });
        if (selected === 'points') {
            const link = el('button', 'btn btn-quiet', t('bets.trade.linkWallet', 'Link wallet to points history'));
            link.type = 'button';
            link.addEventListener('click', async () => {
                track('action_start', { action: 'link-wallet', result: 'started' });
                const provider = root.solanaWalletManager?.getProvider?.();
                if (!provider?.publicKey) {
                    track('action_end', { action: 'link-wallet', result: 'failed', errorCode: 'wallet-not-connected' });
                    root.handleWalletButtonClick?.(); return;
                }
                link.disabled = true;
                try {
                    const result = await trading.linkWallet(provider);
                    const account = await trading.readAccount();
                    if (account.wallet !== result.wallet) throw new Error('The wallet link was not observed');
                    link.textContent = t('bets.trade.walletLinked', 'Wallet linked to this points history');
                    track('action_end', { action: 'link-wallet', result: 'succeeded' });
                } catch (error) {
                    track('action_end', { action: 'link-wallet', result: root.BetsTelemetry?.errorResult(error) || 'failed' });
                    balance.textContent = errorText(error); link.disabled = false;
                }
            });
            section.append(link, el('p', 'bets-account__note', t('bets.trade.publicPositions', 'Points positions are public.')));
            trading.pending().then(value => {
                if (!section.isConnected || !value) return;
                const retry = el('button', 'btn btn-quiet', t('bets.trade.checkPending', 'Check pending receipt'));
                retry.type = 'button';
                retry.addEventListener('click', async () => {
                    retry.disabled = true;
                    track('action_start', { action: 'check-receipt', result: 'started' });
                    try {
                        const result = await trading.retryPending();
                        if (!result?.receipt) {
                            track('action_end', { action: 'check-receipt', result: 'unknown' });
                            retry.remove(); return;
                        }
                        balance.textContent = t('bets.trade.confirmed', 'Confirmed'); retry.remove();
                        track('action_end', { action: 'check-receipt', result: 'confirmed' });
                        doc.dispatchEvent(new root.CustomEvent('bets:changed', { detail: { account: result.receipt.agreementAccount } }));
                    } catch (error) {
                        track('action_end', { action: 'check-receipt', result: root.BetsTelemetry?.errorResult(error) || 'failed' });
                        balance.textContent = errorText(error); retry.disabled = false;
                    }
                }); section.append(retry);
            }).catch(() => { /* balance read above shows the account failure */ });
        } else {
            const actions = el('p', 'cb-link-row');
            const connect = el('button', 'btn btn-quiet', t('bets.trade.connect', 'Connect wallet')); connect.type = 'button';
            connect.addEventListener('click', () => root.handleWalletButtonClick?.()); actions.append(connect);
            [['https://faucet.solana.com', 'solFaucet', 'Get devnet SOL'], ['https://faucet.circle.com', 'usdcFaucet', 'Get devnet USDC']].forEach(([href, key, text]) => {
                const link = el('a', 'cb-link cb-link--external', t(`bets.trade.${key}`, text));
                link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link);
            }); section.append(actions);
        }
        return section;
    }
    root.BetsUI = { t, money, shares, deadline, price, errorText, statusText, assetControl };
})(typeof window !== 'undefined' ? window : null);
