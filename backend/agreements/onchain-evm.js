// The EVM side of the agreement index (docs/blockchain-flows.md, R4): the key an agreement's sponsor and
// CID derive on the Agreement contract (blockchain/contracts/Agreement.sol keyOf), the contract's Record
// as the index's `onchain` JSON (the Solana spelling's EVM counterpart, agreements/onchain.js, with the
// same status codes and wei for lamports), and the chain object POST /agreements/:cid/onchain and the
// lifecycle oracle (oracle/agreement-lifecycle.js) read agreements through: one chain id, its Agreement
// contract, reads pinned to one block so a row's `observedSlot` is the block it was read at, and the
// contract's terminal event logs (AgreementExecuted, AgreementCancelled, AgreementExpired) with the
// block times the oracle dates their land events by.

import { ethers } from 'ethers';
import { agreementConfig, agreementReader, evmProvider } from '../chain/evm.js';
import { isEvmAddress } from '../chain/keys.js';
import { ONCHAIN_STATUSES } from './onchain.js';

// Agreement.sol's DECISION_SATISFIED: the lens attests only `satisfied` (lens-schemas.js LENS_DECISIONS).
const DECISION_SATISFIED = 1;
// What the contract can still change after `onchain` is first written, plus the observation itself.
// Sponsor, lens, payout, deadline, createdAt and requiredWei are fixed at create.
export const EVM_MOVING_FIELDS = Object.freeze(['status', 'decision', 'escrowWei', 'executedAt', 'observedAt', 'observedSlot']);

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const BYTES32_PATTERN = /^0x[0-9a-f]{64}$/;

// Agreement.sol's events that leave an agreement terminal, by the status they leave it in.
export const AGREEMENT_TERMINAL_EVENTS = Object.freeze({ executed: 'AgreementExecuted', cancelled: 'AgreementCancelled', expired: 'AgreementExpired' });
export const AGREEMENT_TERMINAL_EVENTS_ABI = Object.freeze([
    'event AgreementExecuted(bytes32 indexed key, string cid, address payout, uint256 wei_, address lens, bytes32 decisionAttestation, uint64 executedAt)',
    'event AgreementCancelled(bytes32 indexed key, string cid, uint256 refundedWei, uint64 cancelledAt)',
    'event AgreementExpired(bytes32 indexed key, string cid, uint256 refundedWei, uint64 expiredAt)'
]);

/** Whether `value` is an EVM transaction hash (0x and 64 hex digits). */
export const isEvmTransactionHash = value => typeof value === 'string' && TX_HASH_PATTERN.test(value);

/** The CAIP-2 name of an EVM chain, `eip155:<chainId>`: the `chain` of its land events. */
export const evmChainLabel = chainId => `eip155:${chainId}`;

/**
 * One terminal event log as ethers queryFilter returns it (an EventLog over AGREEMENT_TERMINAL_EVENTS_ABI)
 * as plain values: { outcome, key, cid, at (the event's own Unix seconds), payout, wei, lens,
 * decisionAttestation (executed) or refundedWei (cancelled, expired), transaction, block, logIndex,
 * address, topics, data, removed }. Throws on a log the ABI did not decode.
 */
export function evmTerminalLogOf(log) {
    const name = log?.fragment?.name;
    const outcome = Object.keys(AGREEMENT_TERMINAL_EVENTS).find(key => AGREEMENT_TERMINAL_EVENTS[key] === name);
    if (!outcome || !log.args) throw new Error(`log ${log?.transactionHash}#${log?.index} is not a decodable Agreement terminal event`);
    const { args } = log;
    const event = { outcome, key: String(args.key).toLowerCase(), cid: String(args.cid) };
    if (outcome === 'executed') {
        Object.assign(event, {
            payout: ethers.getAddress(args.payout), wei: BigInt(args.wei_).toString(), lens: ethers.getAddress(args.lens),
            decisionAttestation: String(args.decisionAttestation).toLowerCase(), at: safeNumber(args.executedAt, 'executedAt')
        });
    } else {
        Object.assign(event, { refundedWei: BigInt(args.refundedWei).toString(), at: safeNumber(outcome === 'cancelled' ? args.cancelledAt : args.expiredAt, `${outcome}At`) });
    }
    return {
        ...event,
        transaction: log.transactionHash,
        block: log.blockNumber,
        logIndex: log.index,
        address: ethers.getAddress(log.address),
        topics: [...log.topics],
        data: log.data,
        removed: Boolean(log.removed)
    };
}

/** keyOf(sponsor, cid) = keccak256(abi.encode(address sponsor, string cid)), lower-case hex; null without an EVM sponsor. */
export function evmAgreementKeyOf(sponsor, cid) {
    if (!isEvmAddress(sponsor) || typeof cid !== 'string' || !cid) return null;
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'string'], [sponsor, cid]));
}

// uint64/uint256/uint8 from the contract as a safe JS number (times, codes) or a decimal string (wei).
function safeNumber(value, label) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} ${value} is not a safe whole number`);
    return number;
}
const isoOf = seconds => (seconds ? new Date(seconds * 1000).toISOString() : null);

/**
 * The contract's Record at `key` (an ethers Result, or any object with its field names) as plain values:
 * addresses checksummed, times in Unix seconds, wei as decimal strings, status and decision as their codes.
 */
export function evmAccountOf(key, record) {
    const address = label => ethers.getAddress(record[label]);
    return {
        address: key,
        sponsor: address('sponsor'),
        lens: address('lens'),
        payout: address('payout'),
        deadline: safeNumber(record.deadline, 'deadline'),
        createdAt: safeNumber(record.createdAt, 'createdAt'),
        requiredWei: BigInt(record.requiredWei).toString(),
        escrowWei: BigInt(record.escrowWei).toString(),
        statusCode: safeNumber(record.status, 'status'),
        openGround: Boolean(record.openGround),
        decisionCode: safeNumber(record.decision, 'decision'),
        decisionAttestation: String(record.decisionAttestation).toLowerCase(),
        executedAt: safeNumber(record.executedAt, 'executedAt'),
        cid: String(record.cid)
    };
}

/**
 * The index's `onchain` for an agreement read on an EVM chain (evmAccountOf), observed at `observedAt`
 * (this server's clock when it read the contract: an observation time, never an event time) in block
 * `observedSlot`. Wei are decimal strings; deadline, createdAt and executedAt are the contract's own
 * block times. The signature, a transaction hash, only when it verified.
 */
export function onchainFromEvmRecord(record, { chainId, contract, observedAt, observedSlot, signature = null }) {
    const status = ONCHAIN_STATUSES[record.statusCode];
    if (!status) throw new Error(`agreement ${record.address} has status ${record.statusCode}: an unknown code`);
    return {
        chain: 'evm',
        chainId: String(chainId),
        contract,
        account: record.address,
        sponsor: record.sponsor,
        lens: record.lens,
        payout: record.payout,
        status,
        decision: record.decisionCode === DECISION_SATISFIED ? 'satisfied' : 'pending',
        deadline: isoOf(record.deadline),
        createdAt: isoOf(record.createdAt),
        requiredWei: record.requiredWei,
        escrowWei: record.escrowWei,
        executedAt: isoOf(record.executedAt),
        observedAt,
        observedSlot,
        ...(signature ? { signature } : {})
    };
}

/** Whether a fresh observation moves anything but the observation itself. */
export function evmOnchainMoved(stored, fresh) {
    return ['status', 'decision', 'escrowWei', 'executedAt'].some(field => stored?.[field] !== fresh[field]);
}

/**
 * Agreements on one EVM chain, read through its Agreement contract. `reader` (get/exists with ethers
 * overrides) and `provider` (getNetwork, getBlockNumber, getTransactionReceipt, getBlock, getLogs)
 * default to chain/evm.js agreementReader and evmProvider. The first call checks that the RPC really is
 * that chain and fails with code 'rpc-wrong-chain' otherwise. Throws 'unknown-chain' / 'no-agreement' /
 * 'no-rpc' at once for a chain without an Agreement.
 */
export function evmAgreementChain(chainId, { env = process.env, reader = null, provider = null, addressBook } = {}) {
    const config = agreementConfig(chainId, env, addressBook ? { addressBook } : {});
    const rpc = provider || evmProvider(config.chainId, { env });
    const contract = reader || agreementReader(config.chainId, { env, provider: rpc, addressBook });
    // The terminal events, read with queryFilter (ethers reads logs through the runner's `provider`).
    const events = new ethers.Contract(config.addresses.Agreement, AGREEMENT_TERMINAL_EVENTS_ABI, rpc);
    let networkCheck = null;

    async function ready() {
        networkCheck ??= rpc.getNetwork().then(network => {
            if (String(network.chainId) !== config.chainId) {
                throw Object.assign(new Error(`the RPC for ${config.name} answers chain ${network.chainId}, not ${config.chainId}`), { code: 'rpc-wrong-chain' });
            }
        }).catch(error => {
            networkCheck = null;
            throw error;
        });
        await networkCheck;
        return rpc;
    }

    // One row per key, all read at one block: { address: key, slot: block, account | null,
    // problem: null | 'missing' | 'undecodable' }.
    async function readAccounts(keys) {
        await ready();
        const block = await rpc.getBlockNumber();
        const overrides = { blockTag: block };
        const rows = [];
        for (const key of keys) {
            const row = { address: key, slot: block, account: null, problem: null };
            if (!BYTES32_PATTERN.test(key)) row.problem = 'missing';
            else if (!await contract.exists(key, overrides)) row.problem = 'missing';
            else {
                try {
                    row.account = evmAccountOf(key, await contract.get(key, overrides));
                } catch {
                    row.problem = 'undecodable';
                }
            }
            rows.push(row);
        }
        return rows;
    }

    return {
        family: 'evm',
        chainId: config.chainId,
        name: config.name,
        contract: config.addresses.Agreement,
        label: `evm:${config.chainId}`,
        connection: ready,
        readAccounts,
        async readAccount(key) {
            return (await readAccounts([key]))[0];
        },
        // The `outcome` event logs of agreement `key` in blocks fromBlock..toBlock (inclusive), oldest
        // first, as evmTerminalLogOf reads them. The RPC may refuse a range it finds too wide: the caller
        // pages (oracle/agreement-lifecycle.js findEvmTerminalLog).
        async terminalLogs({ key, outcome, fromBlock, toBlock }) {
            const name = AGREEMENT_TERMINAL_EVENTS[outcome];
            if (!name) throw new Error(`${outcome} is not a terminal agreement status`);
            await ready();
            const logs = await events.queryFilter(events.filters[name](key), fromBlock, toBlock);
            return logs.map(evmTerminalLogOf);
        },
        // The block's own timestamp in Unix seconds, or null when the RPC does not know the block.
        async blockTime(number) {
            await ready();
            const block = await rpc.getBlock(number);
            return block ? Number(block.timestamp) : null;
        },
        // Whether a reported transaction succeeded and was sent to the Agreement contract: 'ok',
        // 'not-found' (unknown to the RPC, perhaps not yet), 'failed' or 'unrelated'.
        async transactionTouches(hash) {
            await ready();
            const receipt = await rpc.getTransactionReceipt(hash);
            if (!receipt) return 'not-found';
            if (receipt.status !== 1) return 'failed';
            return typeof receipt.to === 'string' && receipt.to.toLowerCase() === config.addresses.Agreement.toLowerCase() ? 'ok' : 'unrelated';
        }
    };
}
