// evm-agreement.js — the browser wallet side of the EVM Agreement contract (blockchain-flows.md, R4;
// blockchain/contracts/Agreement.sol), with the surface of solana/agreement-bridge.js so the
// agreement panel drives either chain the same way. An agreement proposed with an EVM wallet is
// created by that sponsor at keyOf(sponsor, cid) = keccak256(abi.encode(sponsor, cid)); the sponsor
// funds its escrow (wei) and may cancel it until a satisfied decision is recorded; anyone records the
// lens's EAS AgreementDecision attestation (its uid, listed by the lens member's service), executes a
// satisfied and funded agreement, or expires one past its deadline. Every send is simulated first
// (staticCall) so a refusal names the contract's error, then reports the status states of the Solana
// bridge (preparing → awaiting_signature → submitted → confirmed). window.EvmAgreementBridge; the pure
// helpers are exported for node (backend/test/evm-agreement.test.js).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') {
        const { browser, ...pure } = api;
        root.EvmAgreementBridge = Object.freeze({ ...pure, ...browser(root) });
    }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const evmAdapter = () => root.EvmAdapter || (typeof require === 'function' ? require('./evm-adapter.js') : null);
    const solanaBridge = () => root.AgreementBridge || (typeof require === 'function' ? require('../solana/agreement-bridge.js') : null);
    const lensCore = () => root.LensCore || (typeof require === 'function' ? require('../lens-core.js') : null);
    const idOf = value => (value === undefined || value === null ? '' : String(value).trim());

    const STATUS_NAMES = Object.freeze(['Active', 'Executed', 'Cancelled', 'Expired']);
    const DECISION_NAMES = Object.freeze(['Pending', 'Satisfied']);
    const constants = Object.freeze({ STATUS_ACTIVE: 0, STATUS_EXECUTED: 1, STATUS_CANCELLED: 2, STATUS_EXPIRED: 3, DECISION_PENDING: 0, DECISION_SATISFIED: 1, NO_DEADLINE: 0 });
    const WEI_PER_ETH = 10n ** 18n;
    const DECIMALS = 18;
    const UID = /^0x[0-9a-fA-F]{64}$/;

    // Agreement.sol's Record, field for field, and the calls and errors the browser uses.
    const RECORD_TUPLE = '(address sponsor, address lens, address payout, uint64 deadline, uint64 createdAt, uint256 requiredWei, uint256 escrowWei, '
        + 'uint8 status, bool openGround, uint8 decision, uint64 decisionAttestedAt, uint64 decisionObservedAt, bytes32 decisionAttestation, '
        + 'bytes32 decisionHash, uint64 executedAt, string cid)';
    const AGREEMENT_ABI = Object.freeze([
        'function create(string cid, address lens, uint64 deadline, bool openGround, uint256 requiredWei, address payout) payable returns (bytes32)',
        'function fund(bytes32 key) payable',
        'function attest(bytes32 key, bytes32 uid)',
        'function execute(bytes32 key)',
        'function cancel(bytes32 key)',
        'function expire(bytes32 key)',
        'function exists(bytes32 key) view returns (bool)',
        `function get(bytes32 key) view returns (${RECORD_TUPLE})`,
        'function keyOf(address sponsor, string cid) pure returns (bytes32)',
        'function count() view returns (uint256)',
        'error InvalidCid()', 'error InvalidLens()', 'error InvalidPayout()', 'error InvalidDeadline()', 'error AgreementExists()',
        'error NoSuchAgreement()', 'error NotSponsor()', 'error NotActive()', 'error DeadlinePassed()', 'error DeadlineNotPassed()',
        'error NoDeadline()', 'error NothingToFund()', 'error DecisionRecorded()', 'error DecisionPending()',
        'error EscrowShort(uint256 escrowWei, uint256 requiredWei)', 'error WrongAttester(address attester)', 'error WrongSchema(bytes32 schema)',
        'error AttestationRevoked()', 'error AttestationExpired()', 'error WrongAgreement(string agreementCid)', 'error WrongSponsor(address sponsor)',
        'error InvalidDecision(string decision)', 'error ObservedInFuture(uint64 sourceObservedAt)', 'error PayoutFailed()'
    ]);

    const failure = (message, code, extra = {}) => Object.assign(new Error(message), { code }, extra);
    const isEvmAddress = value => lensCore().isEvmAddress(value);
    const sameAddress = (a, b) => isEvmAddress(a) && isEvmAddress(b) && a.trim().toLowerCase() === b.trim().toLowerCase();

    // ---- pure ------------------------------------------------------------------------------------

    /** The contract's key of an agreement: keccak256(abi.encode(sponsor, cid)). */
    function keyOf(sponsor, cid, ethers = root.ethers) {
        if (!ethers) throw failure('The ethers library is not loaded.', 'ethers-unavailable');
        if (!isEvmAddress(sponsor)) throw failure(`Not an EVM address: ${sponsor}`, 'invalid-sponsor');
        return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'string'], [ethers.getAddress(sponsor.trim().toLowerCase()), String(cid)]));
    }

    // Wei as an ETH number, for display only (CbFormat formats it).
    const amountOf = wei => Number(typeof wei === 'bigint' ? wei : BigInt(wei || 0)) / 1e18;

    // An ETH amount (a number as CbFormat.parseDecimal reads it, or a decimal string) as wei, or null
    // when it is not a positive amount (zero with allowZero) of at most 18 decimals.
    function unitsFrom(amount, { allowZero = false } = {}) {
        let text;
        if (typeof amount === 'number') {
            if (!Number.isFinite(amount) || amount < 0) return null;
            text = /e/i.test(String(amount)) ? amount.toFixed(DECIMALS) : String(amount);
        } else if (typeof amount === 'string') {
            text = amount.trim();
        } else {
            return null;
        }
        const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
        if (!match) return null;
        const fraction = (match[2] || '').replace(/0+$/, '');
        if (fraction.length > DECIMALS) return null;
        const wei = BigInt(match[1]) * WEI_PER_ETH + BigInt((fraction || '0').padEnd(DECIMALS, '0'));
        return wei === 0n && !allowZero ? null : wei;
    }

    // The deadline the contract takes: unix seconds from the agreement's ISO deadline, 0 for none.
    function deadlineSeconds(deadline) {
        if (deadline === null || deadline === undefined || deadline === '') return constants.NO_DEADLINE;
        const ms = Date.parse(deadline);
        if (!Number.isFinite(ms)) throw failure(`deadline ${JSON.stringify(deadline)} is not a date`, 'invalid-deadline');
        return Math.floor(ms / 1000);
    }

    // The explorer page of a transaction (`signature`), else of the Agreement contract an account (a
    // key) lives in; null when the chain has no explorer or the contract is not known.
    function explorerUrl({ signature = null, chainId = null, contract = null } = {}) {
        if (signature) return evmAdapter().explorerUrl(chainId, { tx: signature });
        return contract ? evmAdapter().explorerUrl(chainId, { address: contract }) : null;
    }

    // The chain entry a minted agreement record names ({ chain: 'evm', chainId, account }), or null.
    function onchainRef(agreement) {
        const onchain = agreement && agreement.onchain;
        if (!onchain || onchain.chain !== 'evm') return null;
        const chainId = evmAdapter().normalizeChainId(onchain.chainId);
        const account = idOf(onchain.account);
        if (!chainId || !/^0x[0-9a-fA-F]{64}$/.test(account)) return null;
        return { chainId, account, contract: isEvmAddress(onchain.contract) ? onchain.contract.trim() : null };
    }

    // The lens member an EVM mint names: AgreementBridge.mintLens over EVM addresses only.
    const mintLens = (agreement, configured = []) => solanaBridge().mintLens(agreement, configured, isEvmAddress);

    const deadlinePassed = (value, nowSeconds) => !!value && value.deadline !== constants.NO_DEADLINE && nowSeconds >= value.deadline;

    // What the contract would accept now, with the Solana bridge's semantics: fund and cancel are the
    // sponsor's (cancel only before a decision is recorded); attest needs a known attestation uid;
    // execute needs Satisfied and escrow ≥ required; expire only after the deadline. `wallet` is the
    // connected EVM address (any letter case) or null; every send needs one to pay the gas.
    function chainActions(value, { wallet = null, nowSeconds = Math.floor(Date.now() / 1000), attestation = null } = {}) {
        const active = !!value && value.statusCode === constants.STATUS_ACTIVE;
        const passed = deadlinePassed(value, nowSeconds);
        const authority = !!wallet && !!value && sameAddress(value.authority, wallet);
        const funded = !!value && value.escrowLamports >= value.requiredLamports;
        return {
            fund: active && authority && !passed,
            attest: active && !!wallet && !!attestation && value.decisionCode === constants.DECISION_PENDING && !passed,
            execute: active && !!wallet && value.decisionCode === constants.DECISION_SATISFIED && funded && !passed,
            cancel: active && authority && value.decisionCode !== constants.DECISION_SATISFIED,
            expire: active && !!wallet && passed,
            authority,
            funded,
            deadlinePassed: passed
        };
    }

    const seconds = value => Number(value || 0);
    const checksum = (value, ethers) => {
        const text = String(value);
        try { return ethers && ethers.getAddress ? ethers.getAddress(text) : text; } catch (_) { return text; }
    };

    /**
     * A `get(key)` Record as the panel reads a Solana account: the names of AgreementClient.readAgreement
     * (authority = the sponsor, amounts in wei under escrowLamports/requiredLamports, times in unix
     * seconds, deadline 0 for none), plus currency 'ETH', decimals 18 and where it lives.
     */
    function valueOf(record, { key = null, chainId = null, contract = null, ethers = root.ethers } = {}) {
        const field = (name, index) => (record[name] !== undefined ? record[name] : record[index]);
        const statusCode = Number(field('status', 7));
        const decisionCode = Number(field('decision', 9));
        const pending = decisionCode === constants.DECISION_PENDING;
        return {
            address: key,
            cid: String(field('cid', 15)),
            authority: checksum(field('sponsor', 0), ethers),
            lens: checksum(field('lens', 1), ethers),
            payout: checksum(field('payout', 2), ethers),
            deadline: seconds(field('deadline', 3)),
            createdAt: seconds(field('createdAt', 4)),
            requiredLamports: BigInt(field('requiredWei', 5)),
            escrowLamports: BigInt(field('escrowWei', 6)),
            statusCode,
            status: STATUS_NAMES[statusCode] || `Unknown(${statusCode})`,
            openGround: !!field('openGround', 8),
            decisionCode,
            decision: DECISION_NAMES[decisionCode] || `Unknown(${decisionCode})`,
            decisionAttestedAt: seconds(field('decisionAttestedAt', 10)),
            decisionObservedAt: seconds(field('decisionObservedAt', 11)),
            decisionAttestation: pending ? null : String(field('decisionAttestation', 12)),
            decisionHash: pending ? null : String(field('decisionHash', 13)),
            executedAt: seconds(field('executedAt', 14)),
            currency: 'ETH',
            decimals: DECIMALS,
            chainId,
            contract
        };
    }

    /**
     * The agreement at `key` read through `contract` (an ethers Contract over AGREEMENT_ABI), checked to
     * hold `cid` and belong to `sponsor` when given; null when the contract has no such agreement.
     */
    async function readAgreement(contract, { key, cid = null, sponsor = null, chainId = null, address = null, ethers = root.ethers } = {}) {
        if (!(await contract.exists(key))) return null;
        const value = valueOf(await contract.get(key), { key, chainId, contract: address, ethers });
        if (cid && value.cid !== cid) throw failure(`The agreement at ${key} holds ${value.cid}, not ${cid}.`, 'cid-mismatch');
        if (sponsor && !sameAddress(value.authority, sponsor)) throw failure(`The agreement at ${key} belongs to ${value.authority}, not ${sponsor}.`, 'sponsor-mismatch');
        return value;
    }

    // Among a lens member's listed attestations (LensCore.normalizeAttestations), the EAS
    // AgreementDecision this agreement can record: an EVM decision entry on this chain, naming this
    // CID and the agreement's sponsor, with a uid, unexpired. null when none is.
    function decisionAttestationOf(attestations, { cid, value, chainId, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
        if (!value || !Array.isArray(attestations)) return null;
        const chain = evmAdapter().normalizeChainId(chainId);
        return attestations.find(att => att && att.kind === 'decision' && att.chain === 'evm'
            && evmAdapter().normalizeChainId(att.chainId) === chain && UID.test(idOf(att.uid))
            && att.payload && att.payload.agreementCid === cid && sameAddress(att.payload.sponsor, value.authority)
            && !(typeof att.expiry === 'number' && att.expiry > 0 && att.expiry <= nowSeconds)) || null;
    }

    // The contract's refusal in a few words ("EscrowShort(1, 2)"), from an ethers error: its decoded
    // revert, else revert data parsed with `iface`, else the error's own message.
    function revertReason(error, iface = null) {
        if (!error) return '';
        const nested = [error, error.error, error.info && error.info.error, error.cause].filter(Boolean);
        let parsed = nested.map(item => item.revert).find(revert => revert && revert.name) || null;
        if (!parsed && iface) {
            const data = nested.map(item => item.data).find(value => typeof value === 'string' && /^0x[0-9a-fA-F]{8}/.test(value));
            if (data) {
                try { parsed = iface.parseError(data); } catch (_) { parsed = null; }
            }
        }
        if (parsed && parsed.name) {
            const args = parsed.args ? Array.from(parsed.args).map(String) : [];
            return args.length ? `${parsed.name}(${args.join(', ')})` : parsed.name;
        }
        return error.reason || error.shortMessage || error.message || String(error);
    }

    const chainName = chainId => evmAdapter().chainName(chainId);

    // ---- browser ---------------------------------------------------------------------------------

    function browser(win) {
        const log = (message, extra) => {
            const line = `[${new Date().toISOString()}] [EvmAgreementBridge] ${message}`;
            if (extra === undefined) console.info(line); else console.info(line, extra);
        };
        function t(key, fallback, params = {}) {
            if (typeof win.getProposalI18nHelper === 'function') return win.getProposalI18nHelper()(key, fallback, params);
            return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? params[name] : match));
        }
        const short = key => lensCore().shortKey(key);
        const adapter = () => win.EvmAdapter;

        // The Agreement contract of each chain once addresses.json has been read: links need it at once.
        const contracts = new Map();
        async function agreementAddress(chainId) {
            const entry = await adapter().contractAddresses(chainId);
            const address = entry && isEvmAddress(entry.Agreement) ? entry.Agreement : null;
            if (!address) throw failure(t('agreement.chain.errors.contractMissing', 'The agreement contract is not deployed on {{chain}}.', { chain: chainName(chainId) }), 'contract-missing');
            contracts.set(chainId, address);
            return address;
        }
        const withContract = ref => (ref && !ref.contract && contracts.has(ref.chainId) ? { ...ref, contract: contracts.get(ref.chainId) } : ref);

        // The connected EVM wallet's address (checksummed when ethers is loaded) without asking it, or null.
        function connectedWallet() {
            const state = win.walletManager && typeof win.walletManager.getState === 'function' ? win.walletManager.getState() : null;
            if (!state || state.status !== 'connected' || !Array.isArray(state.accounts) || !state.accounts.length) return null;
            return checksum(state.accounts[0], win.ethers);
        }

        const chainId = () => adapter().walletChainId();

        // The wallet's signer on `wanted` (the agreement's chain; any chain with the contract for a
        // mint) and the Agreement contract bound to it.
        async function signing(wanted = null) {
            const ethers = await adapter().ensureEthers();
            const walletChain = adapter().walletChainId();
            if (!walletChain || !win.walletManager || typeof win.walletManager.getProvider !== 'function') {
                throw failure(t('wallet.connectTitle', 'Connect an Ethereum wallet'), 'wallet-required');
            }
            if (wanted && walletChain !== wanted) {
                throw failure(t('agreement.chain.errors.wrongChain', 'Switch the wallet to {{chain}} to act on this agreement.', { chain: chainName(wanted) }), 'wrong-chain');
            }
            const address = await agreementAddress(walletChain);
            const provider = new ethers.BrowserProvider(win.walletManager.getProvider());
            const signer = await provider.getSigner();
            return { ethers, chainId: walletChain, address, contract: new ethers.Contract(address, AGREEMENT_ABI, signer), wallet: ethers.getAddress(await signer.getAddress()) };
        }

        function emitStatus(options, state, extra = {}) {
            if (options && typeof options.onStatus === 'function') options.onStatus({ state, ...extra });
        }

        // Simulate, sign, send, confirm. A refusal in the simulation names the contract's error; a
        // refusal in the wallet is passed on as the wallet raised it.
        async function send(ctx, method, args, { value = null, onStatus } = {}) {
            emitStatus({ onStatus }, 'preparing');
            const call = value === null ? args : [...args, { value }];
            try {
                await ctx.contract[method].staticCall(...call);
            } catch (error) {
                const reason = revertReason(error, ctx.contract.interface);
                console.warn(`[${new Date().toISOString()}] [EvmAgreementBridge] ${method} would fail: ${reason}`, error);
                throw failure(t('agreement.chain.errors.simulationFailed', 'The transaction would fail: {{reason}}', { reason }), 'simulation-failed', { cause: error, reason });
            }
            emitStatus({ onStatus }, 'awaiting_signature');
            const tx = await ctx.contract[method](...call);
            const link = explorerUrl({ signature: tx.hash, chainId: ctx.chainId });
            emitStatus({ onStatus }, 'submitted', { signature: tx.hash, explorerUrl: link });
            let receipt;
            try {
                receipt = await tx.wait();
            } catch (cause) {
                if (cause && cause.code === 'CALL_EXCEPTION') {
                    throw failure(t('agreement.chain.errors.confirmationFailed', 'The transaction failed on chain.'), 'confirmation-failed', { cause, signature: tx.hash, explorerUrl: link });
                }
                throw failure(t('agreement.chain.errors.confirmationUnknown', 'The transaction was sent, but its confirmation timed out. Check it on the explorer.'),
                    'confirmation-unknown', { cause, signature: tx.hash, explorerUrl: link });
            }
            if (!receipt || receipt.status !== 1) {
                throw failure(t('agreement.chain.errors.confirmationFailed', 'The transaction failed on chain.'), 'confirmation-failed', { signature: tx.hash, explorerUrl: link });
            }
            emitStatus({ onStatus }, 'confirmed', { signature: tx.hash, explorerUrl: link });
            return { signature: tx.hash, explorerUrl: link };
        }

        // The proposed agreement's CID and sponsor, or a refusal in words.
        function publishedOf(agreement) {
            const published = agreement && agreement.published;
            if (!published || !idOf(published.cid)) throw failure(t('agreement.chain.errors.notProposed', 'Propose the agreement before minting it.'), 'not-proposed');
            return { cid: published.cid, sponsor: idOf(published.sponsor) || null };
        }

        function mintedRef(agreement) {
            const ref = onchainRef(agreement);
            if (!ref) throw failure(t('agreement.chain.errors.notMinted', 'This agreement is not minted.'), 'not-minted');
            return ref;
        }

        /**
         * The minted agreement as its chain holds it (valueOf), read through the chain's public
         * provider; null when the contract has no such agreement. Takes the agreement or { agreement }.
         */
        async function read(input) {
            const agreement = input && input.agreement && !input.published ? input.agreement : input;
            const ethers = await adapter().ensureEthers();
            const { cid, sponsor } = publishedOf(agreement);
            const ref = mintedRef(agreement);
            const address = await agreementAddress(ref.chainId);
            const provider = await win.ChainDataLoader.getProviderForChain(ref.chainId);
            const contract = new ethers.Contract(address, AGREEMENT_ABI, provider);
            return readAgreement(contract, { key: ref.account, cid, sponsor: isEvmAddress(sponsor) ? sponsor : null, chainId: ref.chainId, address, ethers });
        }

        /**
         * The lens's decision on a minted agreement, as its member's service lists it: the member is
         * the one that published the agreement's lens as its EVM address in the lens directory, asked
         * GET <service>/lens/attestations?kind=decision&agreementCid=<cid> (AgreementBridge does the
         * same on Solana). Resolves { uid, address (the uid), decision, member } or null; throws
         * code 'lens-unavailable' when the service cannot be read.
         */
        async function findAttestation(agreement, value) {
            if (!value) return null;
            const { cid } = publishedOf(agreement);
            const ref = mintedRef(agreement);
            const unavailable = reason => failure(t('agreement.chain.errors.lensUnavailable', 'The lens member could not be asked for its decision: {{reason}}', { reason }), 'lens-unavailable');
            if (!win.LensPicker || !win.LensServiceClient) throw unavailable('lens client not loaded');
            const directory = await win.LensPicker.loadDirectory();
            const member = (directory.members || []).find(entry => sameAddress(win.LensCore.memberAddress(entry, 'evm'), value.lens)) || null;
            if (!member || !member.serviceUrl) {
                log(`lens ${value.lens} of ${cid} publishes no service address in the directory; its decision cannot be looked up`);
                return null;
            }
            const response = await win.LensServiceClient.fetchAttestations({ serviceUrl: member.serviceUrl, filter: { kind: 'decision', agreementCid: cid } });
            if (!Array.isArray(response.attestations)) throw unavailable((response.outcome && response.outcome.message) || `HTTP ${response.status}`);
            const match = decisionAttestationOf(response.attestations, { cid, value, chainId: ref.chainId });
            log(`lens ${member.key} lists ${response.attestations.length} decision attestation(s) for ${cid}${match ? `; ${match.uid} fits ${chainName(ref.chainId)}` : `; none fits ${chainName(ref.chainId)}`}`);
            return match ? { uid: match.uid, address: match.uid, decision: (match.payload && match.payload.decision) || null, member: member.key } : null;
        }

        // Reads the agreement through the wallet and refuses when it is gone; the shared start of
        // every action after mint.
        async function current(agreement) {
            const { cid, sponsor } = publishedOf(agreement);
            const ref = mintedRef(agreement);
            const ctx = await signing(ref.chainId);
            const value = await readAgreement(ctx.contract, { key: ref.account, cid, sponsor: isEvmAddress(sponsor) ? sponsor : null, chainId: ref.chainId, address: ctx.address, ethers: ctx.ethers });
            if (!value) throw failure(t('agreement.chain.missing', 'The account is not on {{chain}}.', { chain: chainName(ref.chainId) }), 'account-missing');
            return { ref: { ...ref, contract: ctx.address }, ctx, value };
        }

        const result = (sent, ref) => ({ signature: sent.signature, account: ref.account, chainId: ref.chainId, contract: ref.contract, explorerUrl: sent.explorerUrl });

        function requireSponsor(value, ctx) {
            if (!sameAddress(value.authority, ctx.wallet)) {
                throw failure(t('agreement.chain.errors.notAuthority', 'Only the sponsor’s wallet ({{sponsor}}) can do this.', { sponsor: short(value.authority) }), 'not-authority');
            }
        }

        /**
         * Creates a proposed agreement on the wallet's chain: create(cid, lens, deadline, openGround,
         * required, payout) signed by the connected wallet, which must be the sponsor it was proposed
         * with. `required` (wei; `requiredLamports` as the Solana bridge names it) is the escrow
         * execution needs; `payout` receives the whole escrow at execution. An agreement already at
         * the key is this one created before and is returned with signature null.
         * @returns {Promise<{ signature, account, chainId, contract, explorerUrl }>}
         */
        async function mint({ agreement, lens, required, requiredLamports, payout, onStatus } = {}) {
            const { cid, sponsor } = publishedOf(agreement);
            if (onchainRef(agreement) || (agreement.onchain && agreement.onchain.chain)) throw failure(t('agreement.chain.errors.alreadyMinted', 'This agreement is already minted.'), 'already-minted');
            if (!sponsor) {
                throw failure(t('agreement.chain.errors.noSponsor', 'This agreement was proposed without a wallet, so it cannot be minted. Propose it again with this wallet connected.'), 'no-sponsor');
            }
            const ctx = await signing(null);
            if (!sameAddress(ctx.wallet, sponsor)) {
                throw failure(t('agreement.chain.errors.notSponsor', 'Only the sponsor’s wallet ({{sponsor}}) can mint this agreement.', { sponsor: short(sponsor) }), 'not-sponsor');
            }
            if (!isEvmAddress(lens)) throw failure(t('agreement.chain.errors.noLens', 'No lens member is named to attest this agreement’s decision.'), 'no-lens');
            if (!isEvmAddress(payout)) throw failure(t('agreement.chain.errors.payout', 'The payout account must be an address on {{chain}}.', { chain: chainName(ctx.chainId) }), 'invalid-payout');
            const deadline = deadlineSeconds(agreement.deadline);
            if (deadline !== constants.NO_DEADLINE && deadline <= Math.floor(Date.now() / 1000)) {
                throw failure(t('agreement.chain.errors.deadlinePassed', 'The agreement’s deadline has passed.'), 'deadline-passed');
            }
            const units = BigInt(required !== undefined ? required : (requiredLamports !== undefined ? requiredLamports : 0n));
            const key = keyOf(sponsor, cid, ctx.ethers);
            const ref = { chainId: ctx.chainId, account: key, contract: ctx.address };
            if (await ctx.contract.exists(key)) {
                log(`${cid} is already created at ${key} on ${chainName(ctx.chainId)}`);
                return { signature: null, ...ref, explorerUrl: explorerUrl(ref) };
            }
            const openGround = !!(agreement.inputs && agreement.inputs.openGroundM2 > 0);
            const sent = await send(ctx, 'create', [cid, ctx.ethers.getAddress(lens.trim().toLowerCase()), deadline, openGround, units, ctx.ethers.getAddress(payout.trim().toLowerCase())], { onStatus });
            log(`created ${cid} at ${key} on ${chainName(ctx.chainId)}`, { tx: sent.signature, lens, deadline, requiredWei: String(units) });
            return result(sent, ref);
        }

        // The sponsor adds `amount` wei (`lamports` as the Solana bridge names it) to the escrow.
        async function fund({ agreement, amount, lamports, onStatus } = {}) {
            const wei = BigInt(amount !== undefined ? amount : lamports);
            const { ref, ctx, value } = await current(agreement);
            requireSponsor(value, ctx);
            const sent = await send(ctx, 'fund', [ref.account], { value: wei, onStatus });
            log(`funded ${ref.account} with ${String(wei)} wei`, { tx: sent.signature });
            return result(sent, ref);
        }

        // Records the lens's decision from its EAS attestation ({ uid } or the uid). Permissionless:
        // the contract checks the attester, schema, CID, sponsor and decision.
        async function attest({ agreement, attestation, onStatus } = {}) {
            const uid = idOf(attestation && typeof attestation === 'object' ? attestation.uid : attestation);
            if (!UID.test(uid)) throw failure(t('agreement.chain.errors.attestPrecheck', 'The lens decision cannot be recorded ({{reason}}).', { reason: 'invalid-uid' }), 'precheck-failed', { reason: 'invalid-uid' });
            const { ref, ctx } = await current(agreement);
            const sent = await send(ctx, 'attest', [ref.account, uid], { onStatus });
            log(`recorded the lens decision ${uid} on ${ref.account}`, { tx: sent.signature });
            return { ...result(sent, ref), decision: 'satisfied' };
        }

        // Releases the whole escrow to the payout fixed at mint. Permissionless.
        async function execute({ agreement, onStatus } = {}) {
            const { ref, ctx, value } = await current(agreement);
            const sent = await send(ctx, 'execute', [ref.account], { onStatus });
            log(`executed ${ref.account}: ${String(value.escrowLamports)} wei to ${value.payout}`, { tx: sent.signature });
            return result(sent, ref);
        }

        // The sponsor withdraws the agreement; the escrow returns to it.
        async function cancel({ agreement, onStatus } = {}) {
            const { ref, ctx, value } = await current(agreement);
            requireSponsor(value, ctx);
            const sent = await send(ctx, 'cancel', [ref.account], { onStatus });
            log(`cancelled ${ref.account}`, { tx: sent.signature });
            return result(sent, ref);
        }

        // Ends an agreement past its deadline; the escrow returns to its sponsor. Permissionless.
        async function expire({ agreement, onStatus } = {}) {
            const { ref, ctx } = await current(agreement);
            const sent = await send(ctx, 'expire', [ref.account], { onStatus });
            log(`expired ${ref.account}`, { tx: sent.signature });
            return result(sent, ref);
        }

        return {
            mint, fund, attest, execute, cancel, expire, read, findAttestation, connectedWallet, chainId,
            // Links and refs pick up the contract address once a read or action has looked it up.
            onchainRef: agreement => withContract(onchainRef(agreement)),
            explorerUrl: target => explorerUrl(withContract(target || {}))
        };
    }

    return { family: 'evm', currency: 'ETH', decimals: DECIMALS, STATUS_NAMES, DECISION_NAMES, constants, AGREEMENT_ABI,
        keyOf, amountOf, unitsFrom, deadlineSeconds, explorerUrl, onchainRef, mintLens, chainActions, chainName, valueOf, readAgreement,
        decisionAttestationOf, revertReason, browser };
});
