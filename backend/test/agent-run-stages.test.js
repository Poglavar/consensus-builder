// The proposer's per-pick stages (run.mjs advancePick; agents/README.md, "The proposer run"): designed →
// proposed → minted → recorded → staked, each checkpointed before the next, the design and agreement
// checkpointed with their CIDs before they leave the machine, so a rerun resumes and never builds another
// CID, mints twice or stakes twice. The index is a fake that checks what it receives with the index's own
// validators; the owner registry is a mock pool; the mint runs on the agreement program emulator.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { STAGES, advancePick, formatCandidateQuantity, operatedLens, parcelLand, pickIdFor, rivalIndexStatuses, settlementMessage, stageIndex } from '../agents/run.mjs';
import { agreementAccountOf } from '../agents/agreement-minter.js';
import { validateDesignContent } from '../routes/designs.js';
import { validateAgreementContent } from '../routes/agreements.js';
import { cidOf, canonicalBytes } from '../cid.js';
import { createAgreementChain, createLedgerPool } from './helpers/agent-chain-fakes.js';

const require = createRequire(import.meta.url);
const agreementRecord = require('../../frontend/js/agreement-record.js');

const PARCEL_ID = 'HR-335550-1234/1';
const PARCEL = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.9704, 45.8], [15.9704, 45.8003], [15.97, 45.8003], [15.97, 45.8]]] };
const MASSING = { type: 'Polygon', coordinates: [[[15.9701, 45.8001], [15.9703, 45.8001], [15.9703, 45.8002], [15.9701, 45.8002], [15.9701, 45.8001]]] };
const START_MS = Math.floor(Date.now() / 1000) * 1000;

let chain;
let keypair;
let WALLET;
let LENS;
let index;
let journal;

const candidate = (overrides = {}) => ({
    candidateId: `densifier-01:${PARCEL_ID}`, parcelId: PARCEL_ID, parcelSourceId: null, geometry: PARCEL,
    buildingSourceId: 'survey-fixture', buildingCoverage: 'complete', buildingCount: 0, builtFootprintM2: 0, builtGfaM2: 0, builtKnown: true,
    score: 1, gain: 100000, proposedGfaM2: 500, allowedFloors: 4, rule: { source: 'urban-rule', maxFloors: 4, minSetbackM: 3 },
    massing: { type: 'Feature', properties: { floors: 4, height: 13 }, geometry: MASSING }, normalizedRule: null, ...overrides
});
const pick = { pickId: 'agent-densifier-01-2026-10-22-1', candidateId: `densifier-01:${PARCEL_ID}`, name: 'Four storeys on 1234/1', rationale: 'The rule allows four.' };
const freshState = () => ({ designs: {}, owners: {}, agreements: {}, mints: {}, onchain: {}, stakes: {}, bindingFailures: [] });

// The index as the runner sees it: what it receives is checked with the index's own validators, and a
// design binds `bound` (the candidate's parcel unless a test says otherwise).
function fakeIndex({ bound = [PARCEL_ID], coverage = 'complete' } = {}) {
    const designs = new Map();
    const agreements = new Map();
    return {
        designs, agreements,
        publishDesign: vi.fn(async (content, { parcelSourceId }) => {
            journal.push('publishDesign');
            expect(validateDesignContent(content)).toMatchObject({ ok: true });
            const cid = cidOf(canonicalBytes(content));
            const created = !designs.has(cid);
            designs.set(cid, content);
            return { cid, created, row: { cid, city: 'zagreb', parcelSourceId, binding: { parcels: bound.map(parcelId => ({ parcelId })), coverage } } };
        }),
        publishAgreement: vi.fn(async content => {
            journal.push('publishAgreement');
            expect(validateAgreementContent(content)).toMatchObject({ ok: true });
            const cid = cidOf(canonicalBytes(content));
            const created = !agreements.has(cid);
            agreements.set(cid, content);
            return { cid, created, row: { cid, status: 'active' } };
        }),
        recordOnchain: vi.fn(async (cid, body) => { journal.push('recordOnchain'); return { cid, onchain: { account: body.account } }; })
    };
}

function harness({ state = freshState(), owners = [{ parcelUid: PARCEL_ID, owner: null }], persona = {}, until = 'staked', seedOwners = false, stakeUsdc = '0.25', cand = candidate(), now = () => new Date(START_MS) } = {}) {
    const pool = createLedgerPool({ owners: owners.filter(row => row.owner !== undefined).map(row => ({ ...row, owner: row.owner ?? WALLET })) });
    const saves = [];
    const actions = [];
    const fundStake = vi.fn(async () => { journal.push('fundStake'); });
    const args = {
        pick, candidate: cand, tag: 'densifier-01 1/1 agent-densifier-01-2026-10-22-1',
        persona: { name: 'densifier-01', wallet: WALLET, agreement: { deadlineDays: 7, lamports: '1000' }, ...persona },
        keypair, lens: { name: 'lifecycle-01', key: LENS }, until, city: 'zagreb', day: '2026-10-22', slot: 'h08', seedOwners,
        walletNames: { [WALLET]: 'densifier-01' }, stakeUsdc, state, index, pool, connection: chain.connection,
        run: async (action, execute, { entity, message }) => {
            const outcome = await execute();
            actions.push({ type: action.type, action, entity, message });
            return outcome;
        },
        save: async (stage, patch) => { journal.push(`save:${stage ?? '-'}`); saves.push({ stage, patch: JSON.parse(JSON.stringify(patch)) }); },
        sendAndConfirm: chain.sendAndConfirm, now
    };
    return { args, pool, saves, actions, fundStake, state, go: () => advancePick(args) };
}

beforeEach(() => {
    chain = createAgreementChain();
    keypair = Keypair.generate();
    WALLET = keypair.publicKey.toBase58();
    LENS = Keypair.generate().publicKey.toBase58();
    index = fakeIndex();
    journal = [];
});

describe('the stages of one pick', () => {
    it('formats only finite candidate quantities as numbers', () => {
        for (const value of [null, undefined, false, NaN]) expect(formatCandidateQuantity(value)).toBe('unknown');
        expect(formatCandidateQuantity(0)).toBe('0');
        expect(formatCandidateQuantity(1.2351, 3)).toBe('1.235');
    });
    it('rejects an unknown building baseline before any checkpoint or publication', async () => {
        const h = harness({ cand: candidate({ buildingSourceId: null, buildingCoverage: 'unknown', builtGfaM2: 0, builtKnown: true }) });
        await expect(h.go()).rejects.toThrow('Candidate has no supported planning basis; replan before publication or minting.');
        expect(h.saves).toEqual([]);
        expect(journal).toEqual([]);
        expect(index.publishDesign).not.toHaveBeenCalled();
        expect(index.publishAgreement).not.toHaveBeenCalled();
    });
    it('refuses to mint an already published checkpoint when its building baseline is unsupported', async () => {
        const state = freshState();
        await harness({ state, until: 'proposed' }).go();
        expect(state.agreements[pick.candidateId].indexedAt).toBeTruthy();
        journal.length = 0;
        index.publishDesign.mockClear();
        index.publishAgreement.mockClear();
        const resumed = harness({ state, cand: candidate({ buildingCoverage: 'unknown' }) });
        await expect(resumed.go()).rejects.toThrow(/no supported planning basis/);
        expect(resumed.saves).toEqual([]);
        expect(resumed.actions).toEqual([]);
        expect(journal).toEqual([]);
        expect(chain.transactions).toHaveLength(0);
        expect(state.mints).toEqual({});
        expect(index.publishDesign).not.toHaveBeenCalled();
        expect(index.publishAgreement).not.toHaveBeenCalled();
    });
    it('designs, proposes, mints and records, checkpointing the forbidden own-market trade skip', async () => {
        const h = harness();
        expect(await h.go()).toEqual({});
        expect(h.saves.map(save => save.stage)).toEqual([null, 'designed', null, null, 'proposed', 'minted', 'recorded', 'staked']);
        // Each CID is checkpointed before the object leaves the machine; the sponsor never self-trades.
        expect(journal).toEqual(['save:-', 'publishDesign', 'save:designed', 'save:-', 'save:-', 'publishAgreement', 'save:proposed',
            'save:minted', 'recordOnchain', 'save:recorded', 'save:staked']);

        const key = pick.candidateId;
        const design = h.state.designs[key];
        expect(design).toMatchObject({ goal: 'buildings', title: pick.name, terms: { title: pick.name, deadlineDays: 7, lamports: '1000' },
            city: 'zagreb', binding: { parcelIds: [PARCEL_ID], coverage: 'complete' }, indexedAt: new Date(START_MS).toISOString() });
        expect(design.cid).toBe(cidOf(canonicalBytes(design.content)));
        expect(h.state.owners[key]).toEqual({ parcelId: PARCEL_ID, owners: [{ owner: WALLET, ownerCount: 1 }], soleOwner: true, readAt: new Date(START_MS).toISOString() });

        const agreement = h.state.agreements[key];
        expect(agreement.cid).toBe(cidOf(canonicalBytes(agreement.content)));
        expect(agreement.plan.content.designCids).toEqual([design.cid]);
        expect(agreement).toMatchObject({ title: pick.name, lamports: '1000', soleOwner: true, status: 'active', deadline: new Date(START_MS + 7 * 86400000).toISOString() });
        expect(agreement.plan.content.view).toMatchObject({ at: '45.80015,15.9702,17', mode: '2d', city: h.args.city });
        expect(agreement.content).toMatchObject({
            sponsor: WALLET, author: 'densifier-01', city: 'zagreb', deadline: agreement.deadline,
            planCid: agreement.plan.cid,
            inputs: { parcels: [{ parcelId: PARCEL_ID, holders: [{ ownerKey: WALLET, displayName: 'densifier-01', share: 1 }] }], openGroundM2: 0 },
            outputs: [{ hash: agreementRecord.outputHash(PARCEL), role: 'parcel', producedBy: null, fromParcelIds: [PARCEL_ID] }],
            rule: { electorate: 'owners', binding: true, lens: [LENS], approvalConfig: { policy: { type: 'unanimous' } } }
        });
        expect(agreement.content).not.toHaveProperty('designs');

        const account = agreementAccountOf(agreement.cid, WALLET);
        expect(h.state.mints[key]).toMatchObject({ account, created: true, escrowLamports: '1000', cluster: 'devnet' });
        expect(chain.agreement(account)).toMatchObject({ cid: agreement.cid, authority: WALLET, lens: LENS, requiredLamports: 1000n, escrowLamports: 1000n });
        expect(index.recordOnchain).toHaveBeenCalledWith(agreement.cid, { cluster: 'devnet', account, signature: h.state.mints[key].createSignature });
        expect(h.state.onchain[key]).toMatchObject({ account, signature: h.state.mints[key].createSignature });
        expect(h.state.stakes[key]).toEqual({ skipped: true, skipReason: 'agreement-sponsor-cannot-trade-own-market', amount: '0.25' });
        expect(h.fundStake).not.toHaveBeenCalled();

        expect(h.actions.map(item => [item.type, item.entity])).toEqual([
            ['design', { type: 'design', id: design.cid }], ['propose', { type: 'agreement', id: agreement.cid }],
            ['mint', { type: 'agreement', id: agreement.cid }]
        ]);
        expect(h.actions[2].action).toMatchObject({ lens: [LENS], lamports: '1000', pickId: pick.pickId });
        expect(h.actions[1].message).toBe(`densifier-01 proposed "${pick.name}" as a binding agreement on its own parcel ${PARCEL_ID}.`);
    });

    it('publishes and mints an explicit design without inventing a baseline or gain', async () => {
        const h = harness({ cand: candidate({ builtKnown: false, builtGfaM2: null, buildingCoverage: 'unknown',
            gain: null, offer: null, score: null, plannedFloors: 4,
            designPolicy: { kind: 'proposed-design', ruleBasis: 'assumed', footprintM2: 125, openSpaceRatio: 0.5, score: 0.8 } }) });
        expect(await h.go()).toEqual({});
        expect(h.state.agreements[pick.candidateId].content.planCid).toEqual(expect.any(String));
        expect(h.state.mints[pick.candidateId].account).toEqual(expect.any(String));
        expect(h.args.candidate.builtGfaM2).toBeNull(); expect(h.args.candidate.gain).toBeNull();
    });
    it('checkpoints an explicitly funded sponsor market and never self-trades or opens it twice', async () => {
        const h = harness();
        const openMarketImpl = vi.fn(async options => {
            expect(options.maxSeedAtomic).toBe(70_000_000n);
            await options.ensureSeed(69_314_720n);
            return { address: 'market-fixture', seedAtomic: '69314720', signature: 'market-signature' };
        });
        const fundMarketSeed = vi.fn(async () => ({ status: 'funded' }));
        const args = { ...h.args, marketSeedCapUsdc: 70, openMarketImpl, fundMarketSeed };
        await advancePick(args);
        expect(h.state.markets[pick.candidateId].signature).toBe('market-signature');
        expect(h.state.stakes[pick.candidateId].skipReason).toBe('agreement-sponsor-cannot-trade-own-market');
        await advancePick(args);
        expect(openMarketImpl).toHaveBeenCalledTimes(1); expect(fundMarketSeed).toHaveBeenCalledTimes(1);
        expect(h.actions.map(a => a.type)).toContain('openMarket');
    });

    it('keeps seed-funding receipts when market confirmation is interrupted, then resumes by chain state', async () => {
        const h = harness(); let landed = false;
        const fundMarketSeed = vi.fn(async () => ({ status: 'funded', signature: 'seed-funding-signature' }));
        const openMarketImpl = vi.fn(async options => {
            if (landed) return { address: 'market-fixture', seedAtomic: '69314720', replayed: true, signature: null };
            await options.ensureSeed(69_314_720n); landed = true;
            throw new Error('confirmation interrupted');
        });
        const args = { ...h.args, marketSeedCapUsdc: 70, openMarketImpl, fundMarketSeed };
        await expect(advancePick(args)).rejects.toThrow('confirmation interrupted');
        expect(h.state.marketFunding[pick.candidateId].signature).toBe('seed-funding-signature');
        expect(h.saves.some(save => save.patch.marketFunding)).toBe(true);
        expect(h.state.markets[pick.candidateId]).toBeUndefined();
        await advancePick(args);
        expect(h.state.markets[pick.candidateId].replayed).toBe(true);
        expect(fundMarketSeed).toHaveBeenCalledTimes(1);
    });

    it('resumes where it stopped: a rerun signs, publishes and saves nothing; --until stops after a stage', async () => {
        const state = freshState();
        const first = harness({ state, until: 'proposed' });
        await first.go();
        expect(first.saves.map(save => save.stage)).toEqual([null, 'designed', null, null, 'proposed']);
        expect(chain.transactions).toHaveLength(0);

        const resumed = harness({ state, now: () => new Date(START_MS + 60000) });
        await resumed.go();
        expect(resumed.saves.map(save => save.stage)).toEqual(['minted', 'recorded', 'staked']);
        expect(index.publishDesign).toHaveBeenCalledTimes(1);
        expect(index.publishAgreement).toHaveBeenCalledTimes(1);
        // The agreement minted is the one built in the first run, not one rebuilt at the later time.
        expect(chain.agreement(state.mints[pick.candidateId].account).cid).toBe(state.agreements[pick.candidateId].cid);

        const replay = harness({ state });
        await replay.go();
        expect(replay.saves).toEqual([]);
        expect(replay.state.stakes[pick.candidateId].skipReason).toBe('agreement-sponsor-cannot-trade-own-market');
        expect(chain.signed()).toHaveLength(1);
    });

    it('publishes the design it checkpointed, never a second CID, after a crash before the publish', async () => {
        const state = freshState();
        const crashing = harness({ state });
        index.publishDesign.mockImplementationOnce(async () => { throw new Error('index unreachable'); });
        await expect(crashing.go()).rejects.toThrow('index unreachable');
        const stored = state.designs[pick.candidateId];
        expect(stored.indexedAt).toBeUndefined();

        const rerun = harness({ state, now: () => new Date(START_MS + 3600000) });
        await rerun.go();
        expect(state.designs[pick.candidateId].cid).toBe(stored.cid);
        expect(index.publishDesign.mock.calls.at(-1)[0]).toEqual(stored.content);
        expect(index.designs.size).toBe(1);
    });

    it('stops after recording when the persona stakes nothing', async () => {
        const h = harness({ stakeUsdc: '0' });
        await h.go();
        expect(h.saves.at(-1).stage).toBe('recorded');
        expect(h.fundStake).not.toHaveBeenCalled();
    });
});

describe('what the index binds and who owns the land', () => {
    it('refuses a design the index binds to more than its parcel, before any agreement exists', async () => {
        index = fakeIndex({ bound: [PARCEL_ID, 'HR-335550-1235/1'] });
        const h = harness();
        const { refusal } = await h.go();
        expect(refusal).toMatchObject({ code: 'agent-binding-not-candidate', candidateId: pick.candidateId, pickId: pick.pickId, phase: 'design-indexed', bound: 2,
            designCid: h.state.designs[pick.candidateId].cid });
        expect(refusal.reason).toContain(`not exactly ${PARCEL_ID}`);
        expect(h.state.bindingFailures).toEqual([refusal]);
        expect(h.state.designs[pick.candidateId].indexedAt).toBeUndefined();
        expect(index.publishAgreement).not.toHaveBeenCalled();

        index = fakeIndex({ coverage: 'partial' });
        expect((await harness().go()).refusal).toMatchObject({ code: 'agent-binding-not-candidate', reason: expect.stringContaining('coverage partial') });
    });

    it('needs a registered owner, and with --seed-owners registers the persona on land nobody owns', async () => {
        await expect(harness({ owners: [] }).go())
            .rejects.toThrow(`parcel ${PARCEL_ID} has no owner in the devnet owner registry: register it (scripts/seed-lens-owners.mjs --day 2026-10-22 --slot h08 --persona densifier-01 --apply, or run with --seed-owners) and run again`);
        const seeded = harness({ owners: [], seedOwners: true, until: 'proposed' });
        await seeded.go();
        expect(seeded.pool.owners(PARCEL_ID)).toEqual([expect.objectContaining({ owner_wallet: WALLET, owner_count: 1, note: 'agent densifier-01 (run.mjs --seed-owners)' })]);
        expect(seeded.state.owners[pick.candidateId].soleOwner).toBe(true);
    });

    it('never seeds a contest pick, and proposes a rival agreement to the land\'s registered owners', async () => {
        const rival = { persona: 'densifier-01', agreementCid: 'bafkrei' + 'b'.repeat(52), name: 'Six storeys' };
        await expect(harness({ owners: [], seedOwners: true, cand: candidate({ rival }) }).go()).rejects.toThrow(/has no owner in the devnet owner registry/);

        const owner = Keypair.generate().publicKey.toBase58();
        const h = harness({ owners: [{ parcelUid: PARCEL_ID, owner }], cand: candidate({ rival }), persona: { name: 'gentle-01' }, until: 'proposed' });
        await h.go();
        expect(h.state.owners[pick.candidateId]).toMatchObject({ soleOwner: false, owners: [{ owner, ownerCount: 1 }] });
        const { content } = h.state.agreements[pick.candidateId];
        expect(content.sponsor).toBe(WALLET);
        expect(content.inputs.parcels[0].holders).toEqual([{ ownerKey: owner, displayName: owner, share: 1 }]);
        expect(content.rule.approvalConfig.rights.parcels[0].owners).toEqual([{ ownerId: owner, share: '1/1' }]);
        expect(h.actions.find(item => item.type === 'propose').message).toBe(`gentle-01 proposed "${pick.name}" to the owners of parcel ${PARCEL_ID}.`);
    });
});

describe('the runner as a command', () => {
    const RUNNER = fileURLToPath(new URL('../agents/run.mjs', import.meta.url));
    // From a neutral directory, so no .env is read; these paths exit before any database or chain use.
    const cli = (...args) => spawnSync(process.execPath, [RUNNER, ...args], { cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 60000 });
    // Each case starts the runner several times (about 0.8 s each when idle), so a busy machine needs more than the default 5 s.
    const CLI_TEST_TIMEOUT_MS = 60000;

    it('prints its usage without parameters or with --help, and runs nothing', () => {
        for (const args of [[], ['--help']]) {
            const result = cli(...args);
            expect(result.status).toBe(0);
            expect(result.stdout).toContain('--until STAGE        Stop after STAGE: planned | chosen | designed | proposed | minted | recorded | staked');
            expect(result.stdout).toContain('--seed-owners');
        }
    }, CLI_TEST_TIMEOUT_MS);

    it('refuses to be both a dry run and a live run, and an unknown stage or controller', () => {
        expect(cli('--live', '--dry-run').stderr).toContain('choose exactly one of --dry-run or --live');
        for (const args of [['--live', '--dry-run'], ['--dry-run', '--until', 'executed'], ['--dry-run', '--controller', 'oracle'], ['--dry-run', '--candidates', '0']]) {
            expect(cli(...args).status, args.join(' ')).toBe(2);
        }
    }, CLI_TEST_TIMEOUT_MS);
});

describe('run.mjs helpers', () => {
    it('orders the stages and names picks', () => {
        expect(STAGES).toEqual(['planned', 'chosen', 'designed', 'proposed', 'minted', 'recorded', 'staked']);
        expect(stageIndex('minted')).toBeGreaterThan(stageIndex('proposed'));
        expect(stageIndex(null)).toBe(-1);
        expect(pickIdFor({ name: 'densifier-01' }, '2026-10-22-h08', 0)).toBe('agent-densifier-01-2026-10-22-h08-1');
    });

    it('takes the candidate parcel as the one input and the one output, measured from its geometry', () => {
        const land = parcelLand(candidate({ parcelSourceId: 'us-nyc-dof-digital-tax-map' }));
        expect(land.parcels).toEqual([{ parcelId: PARCEL_ID, parcelSourceId: 'us-nyc-dof-digital-tax-map', areaM2: expect.any(Number) }]);
        expect(land.parcels[0].areaM2).toBeGreaterThan(900);
        expect(land.outputs).toEqual([expect.objectContaining({ hash: agreementRecord.outputHash(PARCEL), areaM2: land.parcels[0].areaM2, role: 'parcel' })]);
    });

    it('operates the one lens member whose service names an operator token, by name, key or default', () => {
        const personas = [
            { name: 'notary-01', role: 'lens-member', wallet: 'NotaryKey', service: { url: 'https://lens.test/notary' } },
            { name: 'lifecycle-01', role: 'lens-member', wallet: 'LifecycleKey', service: { url: 'https://lens.test/lifecycle', operatorTokenEnv: 'LIFECYCLE_TOKEN' } }
        ];
        expect(operatedLens(personas, undefined, { LIFECYCLE_TOKEN: 'secret' })).toEqual({
            name: 'lifecycle-01', key: 'LifecycleKey', serviceUrl: 'https://lens.test/lifecycle', tokenEnv: 'LIFECYCLE_TOKEN', operatorToken: 'secret'
        });
        expect(operatedLens(personas, 'LifecycleKey', { AGENT_LENS_SERVICE_URL: 'http://localhost:3096' })).toMatchObject({ serviceUrl: 'http://localhost:3096', operatorToken: null });
        expect(() => operatedLens(personas, 'notary-01', {})).toThrow(/--lens notary-01 is not a lens-member persona whose service names an operator token \(lifecycle-01\)/);
        expect(() => operatedLens([...personas, { ...personas[1], name: 'lifecycle-02', wallet: 'Other' }], undefined, {})).toThrow(/name the lens member to operate/);
    });

    it('reads each rival agreement\'s chain status from its index row, null without an account', async () => {
        const rows = { 'cid-executed': { cid: 'cid-executed', onchain: { status: 'executed', endedAt: '2026-10-21T10:00:00.000Z' } },
            'cid-unminted': { cid: 'cid-unminted', onchain: null } };
        const index = { getAgreement: vi.fn(async cid => rows[cid] ?? null) };
        await expect(rivalIndexStatuses(index, ['cid-executed', 'cid-unminted', 'cid-unknown']))
            .resolves.toEqual({ 'cid-executed': 'executed', 'cid-unminted': null, 'cid-unknown': null });
        expect(index.getAgreement).toHaveBeenCalledTimes(3);
        // An index that cannot answer fails the contest planning rather than guessing the rival open.
        await expect(rivalIndexStatuses({ getAgreement: async () => { throw new Error('index down'); } }, ['cid-executed'])).rejects.toThrow('index down');
    });

    it('marks only retired-agreement 410s as retired admission and propagates other lookup errors', async () => {
        const retired = Object.assign(new Error('Old inline agreement'), { status: 410, code: 'retired-agreement-format' });
        await expect(rivalIndexStatuses({ getAgreement: async () => { throw retired; } }, ['cid-old']))
            .resolves.toEqual({ 'cid-old': 'retired' });
        for (const error of [
            Object.assign(new Error('broken row'), { status: 500, code: 'invalid-agreement-record' }),
            Object.assign(new Error('gone'), { status: 410, code: 'other-410' })
        ]) {
            await expect(rivalIndexStatuses({ getAgreement: async () => { throw error; } }, ['cid-bad'])).rejects.toBe(error);
        }
    });

    it('writes one activity line per settlement step', () => {
        const item = { cid: 'bafkreiexample', outcome: 'NO' };
        const persona = { name: 'densifier-01' };
        expect(settlementMessage(persona, { name: 'lifecycle-01' }, item, 'lens-decision')).toBe('densifier-01 asked lens member lifecycle-01 for its decision on agreement bafkreiexample: satisfied.');
        expect(settlementMessage(persona, null, item, 'expire')).toBe('densifier-01 expired its agreement bafkreiexample after its deadline; the escrow returned to it.');
        expect(settlementMessage(persona, null, item, 'claim')).toBe('densifier-01 claimed its YES refund on agreement bafkreiexample.');
        expect(settlementMessage(persona, null, { ...item, outcome: 'YES' }, 'claim')).toBe('densifier-01 claimed its YES winnings on agreement bafkreiexample.');
    });
});
