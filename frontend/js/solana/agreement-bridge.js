// agreement-bridge.js — the browser wallet side of the agreement program (plan-design-agreement.md,
// "What is minted" and "M3 notes"; blockchain/solana/programs/agreement/README.md). A proposed
// agreement is minted by its sponsor's wallet at PDA(sponsor, cid); the sponsor funds its escrow and
// may cancel it until a satisfied decision is recorded; anyone records the lens's AgreementDecision
// attestation (found at the lens member's service, GET /lens/attestations?kind=decision), executes a
// satisfied and funded agreement, or expires one past its deadline. Every PDA, instruction byte and
// account decode is AgreementClient's (agreement-client.js); this file owns the wallet
// (solanaWalletManager), the connection (SolanaChainDataLoader), the preflight simulation and the
// status states (preparing → awaiting_signature → submitted → confirmed, as market-bridge.js).
// window.AgreementBridge; the pure helpers are exported for node.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') {
        const { browser, ...pure } = api;
        root.AgreementBridge = Object.freeze({ ...pure, ...browser(root) });
    }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const LAMPORTS_PER_SOL = 1000000000n;
    const client = () => {
        const api = root.AgreementClient || (typeof require === 'function' ? require('./agreement-client.js') : null);
        if (!api) throw new Error('AgreementClient (js/solana/agreement-client.js) is not loaded.');
        return api;
    };
    const lensCore = () => root.LensCore || (typeof require === 'function' ? require('../lens-core.js') : null);
    const MAX_REFUNDS_PER_TX = 4;
    const idOf = value => (value === undefined || value === null ? '' : String(value).trim());

    // ---- pure ------------------------------------------------------------------------------------

    // A SOL amount (a number as CbFormat.parseDecimal reads it) as lamports, or null when it is not a
    // positive amount the escrow can hold exactly (at most 9 decimals, within the safe integer range).
    function lamportsFromSol(sol, { allowZero = false } = {}) {
        if (typeof sol !== 'number' || !Number.isFinite(sol) || sol < 0 || (!allowZero && sol === 0)) return null;
        const lamports = Math.round(sol * 1e9);
        if (!Number.isSafeInteger(lamports) || Math.abs(lamports - sol * 1e9) > 1e-3) return null;
        return BigInt(lamports);
    }

    // Lamports as a SOL number, for display only (CbFormat formats it).
    const solOf = lamports => Number(typeof lamports === 'bigint' ? lamports : BigInt(lamports || 0)) / 1e9;

    // The Solana explorer page of an account or a transaction on a cluster.
    function explorerUrl({ account = null, signature = null, cluster = 'devnet' } = {}) {
        const path = signature ? `tx/${encodeURIComponent(signature)}` : `address/${encodeURIComponent(account)}`;
        const suffix = cluster && cluster !== 'mainnet-beta' ? `?cluster=${encodeURIComponent(cluster)}` : '';
        return `https://explorer.solana.com/${path}${suffix}`;
    }

    // The chain account a minted agreement record names ({ chain: 'solana', cluster, account }), or null.
    function onchainRef(agreement) {
        const onchain = agreement && agreement.onchain;
        if (!onchain || onchain.chain !== 'solana' || !idOf(onchain.cluster) || !idOf(onchain.account)) return null;
        return { cluster: idOf(onchain.cluster), account: idOf(onchain.account) };
    }

    // The lens member a mint names: the decision rule's first lens key. A community rule names none,
    // so it takes the first lens member configured in the app (LensPicker): the lens attests the vote
    // count too. null when there is none.
    function mintLens(agreement, configured = [], isKey = value => lensCore().isBase58Pubkey(value)) {
        const rule = agreement && agreement.rule;
        const candidates = rule && rule.electorate !== 'community' ? (Array.isArray(rule.lens) ? rule.lens : []) : configured;
        return (candidates || []).map(entry => idOf(entry && typeof entry === 'object' ? entry.address : entry)).find(key => key && isKey(key)) || null;
    }

    // What the program would accept now (README, "Instructions"), for the account read back
    // (AgreementClient.readAgreement) and the connected wallet (base58 or null; every send needs one
    // to pay the fee). Fund and cancel are the authority's (cancel only before the lens's decision is
    // recorded); attest needs a known attestation. A decision is Pending until Satisfied: there are no
    // refusals.
    function chainActions(value, { wallet = null, nowSeconds = Math.floor(Date.now() / 1000), attestation = null } = {}) {
        const c = client().constants;
        const active = !!value && value.statusCode === c.STATUS_ACTIVE;
        const passed = !!value && client().deadlinePassed(value, nowSeconds);
        const authority = !!wallet && !!value && value.authority === wallet;
        const funded = !!value && value.escrowLamports >= value.requiredLamports;
        return {
            fund: active && authority && !passed,
            attest: active && !!wallet && !!attestation && value.decisionCode === c.DECISION_PENDING && !passed,
            execute: active && !!wallet && value.decisionCode === c.DECISION_SATISFIED && funded && !passed,
            cancel: active && authority && value.decisionCode !== c.DECISION_SATISFIED,
            expire: active && !!wallet && passed,
            authority,
            funded,
            deadlinePassed: passed
        };
    }

    // Among a lens member's listed attestations (LensCore.normalizeAttestations), the AgreementDecision
    // the account can record: issued by the account's lens, naming this CID and the account's sponsor,
    // unexpired. `value` is the account read back (AgreementClient.readAgreement). null when none is.
    function decisionAttestationOf(attestations, { cid, value, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
        if (!value || !Array.isArray(attestations)) return null;
        return attestations.find(att => att && att.kind === 'decision' && att.authority === value.lens
            && att.payload && att.payload.agreementCid === cid && att.payload.sponsor === value.authority
            && !(typeof att.expiry === 'number' && att.expiry > 0 && att.expiry <= nowSeconds)) || null;
    }

    // The Anchor error a failed simulation logged ("Error Code: X. Error Number: n. Error Message: m."), or null.
    function anchorError(logs) {
        const match = (Array.isArray(logs) ? logs.join('\n') : String(logs || '')).match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\.?$/m);
        return match ? { code: match[1], number: Number(match[2]), message: match[3] } : null;
    }

    // ---- browser ---------------------------------------------------------------------------------

    function browser(win) {
        const log = (message, extra) => {
            const line = `[${new Date().toISOString()}] [AgreementBridge] ${message}`;
            if (extra === undefined) console.info(line); else console.info(line, extra);
        };
        function t(key, fallback, params = {}) {
            if (typeof win.getProposalI18nHelper === 'function') return win.getProposalI18nHelper()(key, fallback, params);
            return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? params[name] : match));
        }
        const codedError = (message, code, extra = {}) => Object.assign(new Error(message), { code }, extra);
        const short = key => lensCore().shortKey(key);
        const programId = () => client().constants.AGREEMENT_PROGRAM_ID;

        async function dependencies() {
            if (!win.solanaWeb3?.Transaction && typeof win.ensureWalletVendors === 'function') await win.ensureWalletVendors();
            if (!win.solanaWeb3?.Transaction) throw codedError(t('agreement.chain.errors.web3Unavailable', 'The Solana library could not be loaded.'), 'web3-unavailable');
            if (!win.SolanaChainDataLoader?.getConnection) throw codedError(t('agreement.chain.errors.web3Unavailable', 'The Solana library could not be loaded.'), 'web3-unavailable');
            return client();
        }

        // The connected Solana wallet. Its PublicKey may come from the wallet's own web3.js copy, so
        // it is rebuilt in ours.
        function connectedWallet(provider = win.solanaWalletManager?.getProvider?.()) {
            if (!provider?.publicKey || typeof provider.signTransaction !== 'function') return null;
            return provider.publicKey.toBase58?.() || String(provider.publicKey);
        }

        function walletContext() {
            const provider = win.solanaWalletManager?.getProvider?.();
            const key = connectedWallet(provider);
            if (!key) throw codedError(t('agreement.chain.errors.walletRequired', 'Connect a Solana wallet first.'), 'wallet-required');
            return { provider, wallet: new win.solanaWeb3.PublicKey(key), cluster: win.solanaWalletManager.getCluster() };
        }

        const cluster = () => (win.solanaWalletManager && typeof win.solanaWalletManager.getCluster === 'function' ? win.solanaWalletManager.getCluster() : 'devnet');

        // The program id is a placeholder until the first deploy (agreement-client.js): a cluster
        // without the program is said so before any wallet is asked to sign.
        const deployed = new Set();
        async function ensureDeployed(connection, clusterName) {
            const key = `${clusterName}:${programId()}`;
            if (deployed.has(key)) return;
            const info = await connection.getAccountInfo(new win.solanaWeb3.PublicKey(programId()));
            if (!info || !info.executable) {
                throw codedError(t('agreement.chain.errors.notDeployed', 'The agreement program is not deployed on Solana {{cluster}} yet.', { cluster: clusterName }), 'program-not-deployed');
            }
            deployed.add(key);
        }

        function emitStatus(options, state, extra = {}) {
            if (options && typeof options.onStatus === 'function') options.onStatus({ state, ...extra });
        }

        // Simulate, sign, send, confirm. A simulation failure names the program's error.
        async function send(connection, provider, wallet, clusterName, instructions, options = {}) {
            emitStatus(options, 'preparing');
            const latest = await connection.getLatestBlockhash('confirmed');
            const transaction = new win.solanaWeb3.Transaction({ feePayer: wallet, recentBlockhash: latest.blockhash });
            instructions.forEach(instruction => transaction.add(instruction));
            // A legacy Transaction goes to web3.js 1.x's (transaction, signers?) overload: a config
            // object there throws before anything is signed. No signers: an unsigned simulation.
            const simulation = await connection.simulateTransaction(transaction);
            options.signal?.throwIfAborted();
            if (simulation && simulation.value && simulation.value.err) {
                const logs = simulation.value.logs || [];
                const program = anchorError(logs);
                console.warn(`[${new Date().toISOString()}] [AgreementBridge] simulation failed`, simulation.value.err, logs);
                throw codedError(t('agreement.chain.errors.simulationFailed', 'The transaction would fail: {{reason}}',
                    { reason: program ? program.message : JSON.stringify(simulation.value.err) }), 'simulation-failed',
                { logs, simulationError: simulation.value.err, programError: program ? program.code : null });
            }
            emitStatus(options, 'awaiting_signature');
            const signed = await provider.signTransaction(transaction);
            options.signal?.throwIfAborted();
            const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
            const link = explorerUrl({ signature, cluster: clusterName });
            emitStatus(options, 'submitted', { signature, explorerUrl: link });
            let confirmation;
            try {
                confirmation = await connection.confirmTransaction({ ...latest, signature }, 'confirmed');
            } catch (cause) {
                throw codedError(t('agreement.chain.errors.confirmationUnknown', 'The transaction was sent, but its confirmation timed out. Check it on the explorer.'),
                    'confirmation-unknown', { cause, signature, explorerUrl: link });
            }
            if (confirmation && confirmation.value && confirmation.value.err) {
                throw codedError(t('agreement.chain.errors.confirmationFailed', 'The transaction failed on chain.'), 'confirmation-failed', { signature, explorerUrl: link });
            }
            emitStatus(options, 'confirmed', { signature, explorerUrl: link });
            return { signature, explorerUrl: link };
        }

        // The proposed agreement's CID and sponsor, or a refusal in words.
        function publishedOf(agreement) {
            const published = agreement && agreement.published;
            if (!published || !idOf(published.cid)) throw codedError(t('agreement.chain.errors.notProposed', 'Propose the agreement before minting it.'), 'not-proposed');
            if (agreement.rule?.electorate === 'investors' && (win.AgreementRecord.publishedCid(agreement) !== published.cid || agreement.sponsor !== published.sponsor)) {
                throw codedError(t('agreement.funding.mismatch', 'The funding terms differ from the published agreement.'), 'funding-mismatch');
            }
            return { cid: published.cid, sponsor: idOf(published.sponsor) || null };
        }

        function checkFundingAccount(agreement, clusterName, value) {
            if (agreement.rule?.electorate !== 'investors') return;
            if (clusterName !== 'devnet') throw codedError(t('agreement.funding.devnet', 'Switch to Solana devnet for this funding round.'), 'wrong-cluster');
            if (value && (value.authority !== agreement.sponsor || value.payout !== agreement.sponsor
                || value.lens !== agreement.rule.lens[0] || value.deadline !== Math.floor(Date.parse(agreement.deadline) / 1000)
                || value.requiredLamports !== 0n || value.openGround !== false)) {
                throw codedError(t('agreement.funding.mismatch', 'The funding terms differ from the published agreement.'), 'funding-mismatch');
            }
        }

        // Only explain funding failures. InvalidAccountForFee also occurs for accounts with an
        // ineligible owner or account type. Check the payer and the source ATA at the same slot.
        async function investorFundingError(connection, wallet, amountAtomic, error) {
            const reason = error.simulationError;
            const invalidPayer = reason === 'InvalidAccountForFee' || reason === 'AccountNotFound';
            const logs = error.logs || [];
            const insufficientSol = reason === 'InsufficientFundsForFee' || reason?.InsufficientFundsForRent?.account_index === 0
                || logs.some(line => /Transfer: insufficient lamports/.test(line));
            const tokenError = logs.some(line => /Error: insufficient funds|donor_token_account.*AccountNotInitialized/.test(line));
            if (!invalidPayer && !insufficientSol && !tokenError) return error;
            try {
                const client = pledge();
                const ata = client.getAssociatedTokenAddress(wallet, client.constants.USDC_DEVNET_MINT);
                const { value: [payer, token] } = await connection.getMultipleParsedAccounts([wallet, ata], 'confirmed');
                if (payer !== null && (payer.owner.toBase58() !== client.constants.SYSTEM_PROGRAM_ID || !Number.isSafeInteger(payer.lamports) || payer.lamports < 0)) return error;
                const missingSol = payer === null || payer.lamports === 0 || insufficientSol;
                if (invalidPayer && !missingSol) return error;
                const info = token?.data?.parsed?.info;
                const balance = info?.tokenAmount?.amount;
                if (token !== null && (token.owner.toBase58() !== client.constants.TOKEN_PROGRAM_ID || info?.mint !== client.constants.USDC_DEVNET_MINT
                    || info.owner !== wallet.toBase58() || typeof balance !== 'string' || !/^\d+$/.test(balance))) return error;
                const missingUsdc = token === null || BigInt(balance) < BigInt(amountAtomic);
                if (!missingSol && !missingUsdc) return error;
                const messages = [];
                if (missingSol) messages.push(t('bets.trade.insufficientSol', 'This wallet needs devnet SOL for transaction fees.'));
                if (missingUsdc) messages.push(t('bets.trade.insufficientUsdc', 'This wallet needs devnet USDC. Use the test-money faucet.'));
                return codedError(messages.join(' '), 'insufficient-balance', { cause: error, missingSol, missingUsdc });
            } catch (_) {
                return error;
            }
        }

        function mintedRef(agreement) {
            const ref = onchainRef(agreement);
            if (!ref) throw codedError(t('agreement.chain.errors.notMinted', 'This agreement is not minted.'), 'not-minted');
            return ref;
        }

        /**
         * The agreement's account as the chain holds it (AgreementClient.readAgreement: lamports as
         * BigInt, times in unix seconds), checked to be the agreement program's, to store this CID
         * and to belong to the agreement's sponsor; null when the account is absent.
         */
        async function read(agreement) {
            const api = await dependencies();
            const { cid, sponsor } = publishedOf(agreement);
            const ref = mintedRef(agreement);
            const connection = win.SolanaChainDataLoader.getConnection(ref.cluster);
            const value = await api.fetchAgreement(connection, { address: ref.account, cid, ...(sponsor ? { authority: sponsor } : {}), programId: programId() });
            checkFundingAccount(agreement, ref.cluster, value);
            return value;
        }

        /**
         * The lens's decision on a minted agreement, as its member's service lists it: the member is
         * the account's lens, found in the lens directory (GET /lenses/members) the way the owner
         * verification finds its members, and asked GET <service>/lens/attestations?kind=decision&
         * agreementCid=<cid>. `value` is the account read back. Resolves { address, decision, member }
         * or null when the member has issued none (or publishes no service address); throws code
         * 'lens-unavailable' when the service cannot be read.
         */
        async function findAttestation(agreement, value) {
            if (!value) return null;
            const { cid } = publishedOf(agreement);
            if (!win.LensPicker || !win.LensServiceClient) throw codedError(t('agreement.chain.errors.lensUnavailable', 'The lens member could not be asked for its decision: {{reason}}', { reason: 'lens client not loaded' }), 'lens-unavailable');
            const directory = await win.LensPicker.loadDirectory();
            const member = (directory.members || []).find(entry => entry.key === value.lens) || null;
            if (!member || !member.serviceUrl) {
                log(`lens ${value.lens} of ${cid} publishes no service address in the directory; its decision cannot be looked up`);
                return null;
            }
            const response = await win.LensServiceClient.fetchAttestations({ serviceUrl: member.serviceUrl, filter: { kind: 'decision', agreementCid: cid } });
            if (!Array.isArray(response.attestations)) {
                throw codedError(t('agreement.chain.errors.lensUnavailable', 'The lens member could not be asked for its decision: {{reason}}',
                    { reason: (response.outcome && response.outcome.message) || `HTTP ${response.status}` }), 'lens-unavailable');
            }
            const match = decisionAttestationOf(response.attestations, { cid, value });
            log(`lens ${member.key} lists ${response.attestations.length} decision attestation(s) for ${cid}${match ? `; ${match.address} (${match.payload.decision}) fits the account` : '; none fits the account'}`);
            return match ? { address: match.address, decision: match.payload.decision || null, member: member.key } : null;
        }

        // Reads the account and refuses when it is gone; the shared start of every action after mint.
        async function current(api, agreement) {
            const { cid, sponsor } = publishedOf(agreement);
            const ref = mintedRef(agreement);
            const connection = win.SolanaChainDataLoader.getConnection(ref.cluster);
            const value = await api.fetchAgreement(connection, { address: ref.account, cid, ...(sponsor ? { authority: sponsor } : {}), programId: programId() });
            if (!value) throw codedError(t('agreement.chain.errors.accountMissing', 'The agreement’s account is not on Solana {{cluster}}.', { cluster: ref.cluster }), 'account-missing');
            if (agreement.rule?.electorate === 'investors' && cluster() !== ref.cluster) throw codedError(t('agreement.funding.devnet', 'Switch to Solana devnet for this funding round.'), 'wrong-cluster');
            checkFundingAccount(agreement, ref.cluster, value);
            return { ref, connection, value };
        }

        const result = (sent, ref) => ({ signature: sent.signature, account: ref.account, cluster: ref.cluster, explorerUrl: sent.explorerUrl });

        /**
         * Mints a proposed agreement: create(cid, lens, deadline, open_ground, required_lamports, payout)
         * signed by the connected wallet, which must be the sponsor the agreement was proposed with.
         * `deadline` defaults to the agreement's own (ISO or null); with neither, the agreement gets
         * now + DEFAULT_DEADLINE_SECONDS (90 days). A deadline that is not in the future is refused, as
         * the program refuses it. `requiredLamports` is the escrow
         * execution needs (0: none); `payout` receives the whole escrow at execution. An account
         * already at the address is this agreement minted before and is returned with signature null.
         * @returns {Promise<{ signature, account, cluster, explorerUrl }>}
         */
        async function mint({ agreement, lens, deadline, requiredLamports = 0n, payout, onStatus } = {}) {
            const api = await dependencies();
            const { cid, sponsor } = publishedOf(agreement);
            if (onchainRef(agreement)) throw codedError(t('agreement.chain.errors.alreadyMinted', 'This agreement is already minted.'), 'already-minted');
            if (!sponsor) {
                throw codedError(t('agreement.chain.errors.noSponsor', 'This agreement was proposed without a wallet, so it cannot be minted. Propose it again with this wallet connected.'), 'no-sponsor');
            }
            const { provider, wallet, cluster: clusterName } = walletContext();
            if (agreement.rule?.electorate === 'investors') {
                checkFundingAccount(agreement, clusterName);
                lens = agreement.rule.lens[0];
                payout = sponsor;
                deadline = agreement.deadline;
                requiredLamports = 0n;
            }
            if (wallet.toBase58() !== sponsor) {
                throw codedError(t('agreement.chain.errors.notSponsor', 'Only the sponsor’s wallet ({{sponsor}}) can mint this agreement.', { sponsor: short(sponsor) }), 'not-sponsor');
            }
            if (!idOf(lens)) throw codedError(t('agreement.chain.errors.noLens', 'No lens member is named to attest this agreement’s decision.'), 'no-lens');
            const now = Math.floor(Date.now() / 1000);
            const deadlineSeconds = api.toDeadlineSeconds(deadline ?? agreement.deadline, now);
            if (deadlineSeconds <= now) {
                throw codedError(t('agreement.chain.errors.deadlinePassed', 'The agreement’s deadline has passed.'), 'deadline-passed');
            }
            const connection = win.SolanaChainDataLoader.getConnection(clusterName);
            await ensureDeployed(connection, clusterName);
            const built = api.buildCreateIx({
                authority: wallet,
                cid,
                lens: idOf(lens),
                deadline: deadlineSeconds,
                openGround: !!(agreement.inputs && agreement.inputs.openGroundM2 > 0),
                requiredLamports: BigInt(requiredLamports),
                payout: idOf(payout),
                programId: programId()
            });
            const ref = { cluster: clusterName, account: built.agreement.toBase58() };
            const existing = await api.fetchAgreement(connection, { address: ref.account, cid, authority: sponsor, programId: programId() });
            if (existing) {
                checkFundingAccount(agreement, clusterName, existing);
                log(`${cid} is already minted at ${ref.account} (${clusterName})`);
                return { signature: null, account: ref.account, cluster: clusterName, explorerUrl: explorerUrl(ref) };
            }
            const sent = await send(connection, provider, wallet, clusterName, [built.instruction], { onStatus });
            log(`minted ${cid} at ${ref.account} (${clusterName})`, { signature: sent.signature, lens: idOf(lens), deadline: deadlineSeconds, requiredLamports: String(requiredLamports) });
            return result(sent, ref);
        }

        // The sponsor adds `lamports` (BigInt) to the escrow.
        async function fund({ agreement, lamports, onStatus } = {}) {
            if (agreement?.rule?.electorate === 'investors') throw codedError(t('agreement.funding.usdcOnly', 'Use Contribute to fund this agreement with devnet USDC.'), 'usdc-only');
            const api = await dependencies();
            const { provider, wallet } = walletContext();
            const { ref, connection, value } = await current(api, agreement);
            if (value.authority !== wallet.toBase58()) {
                throw codedError(t('agreement.chain.errors.notAuthority', 'Only the sponsor’s wallet ({{sponsor}}) can do this.', { sponsor: short(value.authority) }), 'not-authority');
            }
            const sent = await send(connection, provider, wallet, ref.cluster, [api.buildFundIx({ agreement: ref.account, authority: wallet, lamports: BigInt(lamports), programId: programId() })], { onStatus });
            log(`funded ${ref.account} with ${String(lamports)} lamports`, { signature: sent.signature });
            return result(sent, ref);
        }

        /**
         * Records the lens's decision: attest() with its AgreementDecision-v1 attestation and the SAS
         * credential it was issued under (read from the attestation when not given). Permissionless:
         * the connected wallet only pays the fee. The checks the two accounts can answer run first.
         */
        async function attest({ agreement, attestation, credential = null, onStatus } = {}) {
            const api = await dependencies();
            const { provider, wallet } = walletContext();
            const { ref, connection, value } = await current(api, agreement);
            const decision = await api.fetchDecisionAttestation(connection, idOf(attestation));
            if (!decision) throw codedError(t('agreement.chain.errors.attestationMissing', 'The lens attestation is not on Solana {{cluster}}.', { cluster: ref.cluster }), 'attestation-missing');
            if (credential && idOf(credential) !== decision.credential) {
                throw codedError(t('agreement.chain.errors.attestPrecheck', 'The lens decision cannot be recorded ({{reason}}).', { reason: 'credential-mismatch' }), 'precheck-failed', { reason: 'credential-mismatch' });
            }
            const problem = api.checkDecisionForAttest({ agreement: value, attestation: decision });
            if (problem) throw codedError(t('agreement.chain.errors.attestPrecheck', 'The lens decision cannot be recorded ({{reason}}).', { reason: problem }), 'precheck-failed', { reason: problem });
            const instruction = api.buildAttestIx({ agreement: ref.account, attestation: decision.address, credential: decision.credential, programId: programId() });
            const sent = await send(connection, provider, wallet, ref.cluster, [instruction], { onStatus });
            log(`recorded the lens decision "${decision.fields.decision}" on ${ref.account}`, { signature: sent.signature, attestation: decision.address });
            return { ...result(sent, ref), decision: decision.fields.decision };
        }

        // Releases the whole escrow to the payout fixed at mint. Permissionless.
        async function execute({ agreement, onStatus } = {}) {
            const api = await dependencies();
            const { provider, wallet } = walletContext();
            const { ref, connection, value } = await current(api, agreement);
            const sent = await send(connection, provider, wallet, ref.cluster, [api.buildExecuteIx({ agreement: ref.account, payout: value.payout, programId: programId() })], { onStatus });
            log(`executed ${ref.account}: ${String(value.escrowLamports)} lamports to ${value.payout}`, { signature: sent.signature });
            return result(sent, ref);
        }

        // The sponsor withdraws the agreement; the escrow returns to it.
        async function cancel({ agreement, onStatus } = {}) {
            const api = await dependencies();
            const { provider, wallet } = walletContext();
            const { ref, connection, value } = await current(api, agreement);
            if (value.authority !== wallet.toBase58()) {
                throw codedError(t('agreement.chain.errors.notAuthority', 'Only the sponsor’s wallet ({{sponsor}}) can do this.', { sponsor: short(value.authority) }), 'not-authority');
            }
            const sent = await send(connection, provider, wallet, ref.cluster, [api.buildCancelIx({ agreement: ref.account, authority: wallet, programId: programId() })], { onStatus });
            log(`cancelled ${ref.account}`, { signature: sent.signature });
            return result(sent, ref);
        }

        // Ends an agreement past its deadline; the escrow returns to its sponsor. Permissionless.
        async function expire({ agreement, onStatus } = {}) {
            const api = await dependencies();
            const { provider, wallet } = walletContext();
            const { ref, connection, value } = await current(api, agreement);
            const sent = await send(connection, provider, wallet, ref.cluster, [api.buildExpireIx({ agreement: ref.account, authority: value.authority, programId: programId() })], { onStatus });
            log(`expired ${ref.account}`, { signature: sent.signature });
            return result(sent, ref);
        }

        // ---- Boost: devnet-USDC donations to the agreement (proposal_pledge, SolanaPledgeClient) ----
        // Anyone can donate while the agreement is active; executing it lets anyone release the escrow
        // to the sponsor; a cancelled or expired agreement lets each donor take back their donations.
        function pledge() {
            if (!win.SolanaPledgeClient) throw codedError(t('agreement.boost.errors.unavailable', 'The boost program client could not be loaded.'), 'pledge-unavailable');
            return win.SolanaPledgeClient;
        }

        // The escrow (totals, or null before the first boost) and, with `mine` and a wallet, its own
        // donations. Listing them needs getProgramAccounts, so callers ask only when a refund is possible.
        async function donations(agreement, { mine: listMine = false } = {}) {
            await dependencies();
            const ref = mintedRef(agreement);
            const connection = win.SolanaChainDataLoader.getConnection(ref.cluster);
            const escrow = await pledge().readDonationEscrow(connection, ref.account);
            const wallet = connectedWallet();
            const mine = listMine && escrow && wallet ? await positionsFor(agreement, connection, ref.account, wallet) : [];
            return { escrow, mine };
        }

        async function apartmentInventory(agreement) {
            await dependencies();
            const { sponsor } = publishedOf(agreement);
            const ref = mintedRef(agreement);
            checkFundingAccount(agreement, ref.cluster);
            const connection = win.SolanaChainDataLoader.getConnection(ref.cluster);
            return pledge().readApartmentInventory(connection, ref.account, sponsor, agreement.funding, win.AgreementRecord);
        }

        function positionsFor(agreement, connection, account, owner) {
            return agreement.funding?.apartments
                ? pledge().apartmentPositions(connection, account, owner, agreement.funding, win.AgreementRecord)
                : pledge().listDonationPositions(connection, account, owner);
        }

        async function apartmentAction({ agreement, unitId, expectedBuyer, onStatus, signal }, listing) {
            const api = await dependencies();
            const { provider, wallet } = walletContext();
            const { ref, connection, value } = await current(api, agreement);
            const client = pledge();
            const offer = (await apartmentInventory(agreement)).find(row => row.unitId === unitId);
            if (!offer) throw codedError(t('agreement.funding.apartments.unknown', 'Choose an apartment offered by this round.'), 'unknown-unit');
            const developer = agreement.sponsor;
            const payer = wallet.toBase58();
            if (expectedBuyer && expectedBuyer !== payer) throw codedError(t('agreement.chain.errors.connectWallet', 'Connect the wallet shown in the reservation.'), 'wallet-changed');
            const receipt = { account: ref.account, cluster: ref.cluster, signature: null, explorerUrl: explorerUrl(ref), position: offer.position };
            if (listing && payer !== developer) throw codedError(t('agreement.funding.apartments.developerOnly', 'Only the developer can list this apartment.'), 'developer-required');
            if ((!listing && offer.status === 'reserved' && offer.buyer === payer) || (listing && offer.status === 'available')) return receipt;
            if (value.status !== 'Active' || api.deadlinePassed(value, Math.floor(Date.now() / 1000))) {
                throw codedError(t('agreement.funding.apartments.closed', 'This apartment round is closed.'), 'round-closed');
            }
            const options = { ...offer, developer, proposal: ref.account, buyer: wallet };
            const instructions = [];
            if (listing) {
                if (offer.status !== 'unlisted') throw codedError(t('agreement.funding.apartments.held', 'This apartment is already reserved.'), 'unit-held');
                if (!await client.readDonationEscrow(connection, ref.account)) {
                    instructions.push(client.buildCreateDonationEscrowIx({ proposal: ref.account, creator: wallet }));
                }
                if (offer.clearedPosition) instructions.push(client.buildClearApartmentRefundIx({ unitAccount: offer.account, position: offer.clearedPosition }));
                instructions.push(client.buildListApartmentIx(options));
            } else {
                if (offer.status !== 'available') throw codedError(t('agreement.funding.apartments.unavailable', 'This apartment is unavailable for reservation.'), 'unit-unavailable');
                const donationId = client.hashBytes(offer.unitKey);
                const escrow = client.getDonationEscrowPda(ref.account)[0];
                receipt.position = client.getDonationPositionPda(escrow, wallet, donationId)[0].toBase58();
                const [vault, previous] = await Promise.all([client.readDonationEscrow(connection, ref.account),
                    client.readDonationPosition(connection, ref.account, wallet, donationId)]);
                if (previous && (previous.refunded || previous.amount !== BigInt(offer.deposit))) throw new Error(t('agreement.funding.apartments.invalidPosition', 'The existing deposit does not match this apartment.'));
                if (!vault) instructions.push(client.buildCreateDonationEscrowIx({ proposal: ref.account, creator: wallet }));
                if (!previous) instructions.push(client.buildDonateIx({ proposal: ref.account, donor: wallet, amount: offer.deposit, donationId }));
                instructions.push(client.buildReserveApartmentIx(options));
            }
            try {
                const sent = await send(connection, provider, wallet, ref.cluster, instructions, { onStatus, signal });
                return { ...receipt, ...result(sent, ref) };
            } catch (error) {
                if (!listing && error.code === 'simulation-failed') throw await investorFundingError(connection, wallet, offer.deposit, error);
                throw error;
            }
        }

        // After a lost confirmation the same wallet retries the same on-chain position. A new,
        // intentional contribution gets a new ID after the previous receipt is observed.
        const pendingDeposits = new Map();
        async function donate({ agreement, amountAtomic, onStatus, signal } = {}) {
            if (agreement?.funding?.apartments) throw codedError(t('agreement.funding.apartments.choose', 'Choose an apartment to reserve.'), 'apartment-required');
            const api = await dependencies();
            const { provider, wallet } = walletContext();
            const { ref, connection, value } = await current(api, agreement);
            if (value.status !== 'Active') throw codedError(t('agreement.boost.errors.notActive', 'Only an active agreement can be boosted.'), 'not-active');
            if (agreement.rule?.electorate === 'investors' && api.deadlinePassed(value, Math.floor(Date.now() / 1000))) {
                throw codedError(t('agreement.chain.errors.deadlinePassed', 'The agreement’s deadline has passed.'), 'deadline-passed');
            }
            const client = pledge();
            const key = agreement.rule?.electorate === 'investors' ? `ugt-investment:${ref.account}:${wallet.toBase58()}:${amountAtomic}` : null;
            const previous = key && (pendingDeposits.get(key) || win.sessionStorage?.getItem(key));
            const operationId = previous || win.crypto.randomUUID();
            const donationId = await client.hashOperationId(operationId);
            const clear = () => { if (key) { pendingDeposits.delete(key); win.sessionStorage?.removeItem(key); } };
            if (previous) {
                const position = await client.readDonationPosition(connection, ref.account, wallet, donationId);
                if (position && position.amount === BigInt(amountAtomic)) {
                    clear();
                    return { signature: null, account: ref.account, cluster: ref.cluster, explorerUrl: explorerUrl(ref) };
                }
            }
            if (key) { pendingDeposits.set(key, operationId); win.sessionStorage?.setItem(key, operationId); }
            const instructions = [];
            if (!(await client.readDonationEscrow(connection, ref.account))) instructions.push(client.buildCreateDonationEscrowIx({ proposal: ref.account, creator: wallet }));
            instructions.push(client.buildDonateIx({ proposal: ref.account, donor: wallet, donationId, amount: BigInt(amountAtomic) }));
            let sent;
            try {
                sent = await send(connection, provider, wallet, ref.cluster, instructions, { onStatus, signal });
            } catch (error) {
                if (key && error.code === 'simulation-failed') throw await investorFundingError(connection, wallet, amountAtomic, error);
                throw error;
            }
            clear();
            log(`boosted ${ref.account} with ${client.formatUsdc(BigInt(amountAtomic))} USDC`, { signature: sent.signature });
            return result(sent, ref);
        }

        async function refundDonations({ agreement, onStatus } = {}) {
            await dependencies();
            const { provider, wallet } = walletContext();
            const ref = mintedRef(agreement);
            const connection = win.SolanaChainDataLoader.getConnection(ref.cluster);
            const open = (await positionsFor(agreement, connection, ref.account, wallet.toBase58())).filter(row => !row.refunded);
            if (!open.length) throw codedError(t('agreement.boost.errors.nothingToRefund', 'This wallet has no boost to take back.'), 'nothing-to-refund');
            // Each position adds accounts and instruction data to a Solana transaction.
            const batch = agreement.rule?.electorate === 'investors' ? open.slice(0, MAX_REFUNDS_PER_TX) : open;
            const inventory = agreement.funding?.apartments ? await apartmentInventory(agreement) : [];
            const instructions = [];
            for (const row of batch) {
                instructions.push(pledge().buildRefundDonationIx({ proposal: ref.account, donor: wallet, donationId: row.donationId }));
                const unit = inventory.find(item => item.status === 'reserved' && item.position === row.address);
                if (unit) instructions.push(pledge().buildClearApartmentRefundIx({ unitAccount: unit.account, position: row.address }));
            }
            const sent = await send(connection, provider, wallet, ref.cluster, instructions, { onStatus });
            log(`refunded ${batch.length} contribution(s) on ${ref.account}`, { signature: sent.signature });
            return result(sent, ref);
        }

        async function releaseDonations({ agreement, onStatus } = {}) {
            const api = await dependencies();
            const { provider, wallet } = walletContext();
            const ref = mintedRef(agreement);
            if (agreement.rule?.electorate === 'investors') await current(api, agreement);
            const connection = win.SolanaChainDataLoader.getConnection(ref.cluster);
            const escrow = await pledge().readDonationEscrow(connection, ref.account);
            if (!escrow || escrow.released) throw codedError(t('agreement.boost.errors.nothingToRelease', 'There are no boosts to release.'), 'nothing-to-release');
            const sent = await send(connection, provider, wallet, ref.cluster,
                [pledge().buildReleaseDonationsIx({ proposal: ref.account, releaser: wallet, beneficiary: escrow.beneficiary })], { onStatus });
            log(`released boosts of ${ref.account} to ${escrow.beneficiary}`, { signature: sent.signature });
            return result(sent, ref);
        }

        return { mint, fund, attest, execute, cancel, expire, read, findAttestation, connectedWallet, cluster, programId,
            donations, donate, refundDonations, releaseDonations, apartmentInventory,
            listApartment: options => apartmentAction(options, true), reserveApartment: options => apartmentAction(options, false) };
    }

    return { LAMPORTS_PER_SOL, MAX_REFUNDS_PER_TX, lamportsFromSol, solOf, explorerUrl, onchainRef, mintLens, chainActions, decisionAttestationOf, anchorError, browser };
});
