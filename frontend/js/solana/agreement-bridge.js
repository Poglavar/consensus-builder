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
        const candidates = rule && rule.electorate === 'owners' ? (Array.isArray(rule.lens) ? rule.lens : []) : configured;
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
        function walletContext() {
            const manager = win.solanaWalletManager;
            const provider = manager && typeof manager.getProvider === 'function' ? manager.getProvider() : null;
            if (!provider || !provider.publicKey || typeof provider.signTransaction !== 'function') {
                throw codedError(t('agreement.chain.errors.walletRequired', 'Connect a Solana wallet first.'), 'wallet-required');
            }
            const key = typeof provider.publicKey.toBase58 === 'function' ? provider.publicKey.toBase58() : String(provider.publicKey);
            return { provider, wallet: new win.solanaWeb3.PublicKey(key), cluster: manager.getCluster() };
        }

        // The connected wallet's address without asking it for anything, or null.
        function connectedWallet() {
            const state = win.solanaWalletManager && typeof win.solanaWalletManager.getState === 'function' ? win.solanaWalletManager.getState() : null;
            return state && state.status === 'connected' && Array.isArray(state.accounts) && state.accounts.length ? String(state.accounts[0]) : null;
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
            return { cid: published.cid, sponsor: idOf(published.sponsor) || null };
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
            return api.fetchAgreement(connection, { address: ref.account, cid, ...(sponsor ? { authority: sponsor } : {}), programId: programId() });
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
            return { ref, connection, value };
        }

        const result = (sent, ref) => ({ signature: sent.signature, account: ref.account, cluster: ref.cluster, explorerUrl: sent.explorerUrl });

        /**
         * Mints a proposed agreement: create(cid, lens, deadline, open_ground, required_lamports, payout)
         * signed by the connected wallet, which must be the sponsor the agreement was proposed with.
         * `deadline` defaults to the agreement's own (ISO or null); `requiredLamports` is the escrow
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
            if (wallet.toBase58() !== sponsor) {
                throw codedError(t('agreement.chain.errors.notSponsor', 'Only the sponsor’s wallet ({{sponsor}}) can mint this agreement.', { sponsor: short(sponsor) }), 'not-sponsor');
            }
            if (!idOf(lens)) throw codedError(t('agreement.chain.errors.noLens', 'No lens member is named to attest this agreement’s decision.'), 'no-lens');
            const deadlineSeconds = api.toDeadlineSeconds(deadline === undefined ? agreement.deadline : deadline);
            if (deadlineSeconds !== api.constants.NO_DEADLINE && deadlineSeconds <= Math.floor(Date.now() / 1000)) {
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
                log(`${cid} is already minted at ${ref.account} (${clusterName})`);
                return { signature: null, account: ref.account, cluster: clusterName, explorerUrl: explorerUrl(ref) };
            }
            const sent = await send(connection, provider, wallet, clusterName, [built.instruction], { onStatus });
            log(`minted ${cid} at ${ref.account} (${clusterName})`, { signature: sent.signature, lens: idOf(lens), deadline: deadlineSeconds, requiredLamports: String(requiredLamports) });
            return result(sent, ref);
        }

        // The sponsor adds `lamports` (BigInt) to the escrow.
        async function fund({ agreement, lamports, onStatus } = {}) {
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

        return { mint, fund, attest, execute, cancel, expire, read, findAttestation, connectedWallet, cluster, programId };
    }

    return { LAMPORTS_PER_SOL, lamportsFromSol, solOf, explorerUrl, onchainRef, mintLens, chainActions, decisionAttestationOf, anchorError, browser };
});
