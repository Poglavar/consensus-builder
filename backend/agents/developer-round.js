// A developer persona's crowdfunding rounds (docs/developer-crowdfunding.md), run by run.mjs beside the
// proposers: each run plans at most one new round on one of its configured named plans (role
// `developer`, personas.json `developer`), offering whole apartments of one of the plan's residential
// buildings (apartment-units.js) at small devnet-USDC prices and deposits, or, every `plainRoundEvery`th
// round, a plain contribution round without apartments. A round goes planned → proposed (agreement/v1
// built and checkpointed before it is indexed) → minted (no native escrow; the USDC target is frozen
// at mint) → recorded → listed (the developer lists every unit) → market (the sponsor opens its
// prediction market under the run's seed allowance). The run's settlement phase then confirms the
// target, has the round's lens member confirm a funded apartment round from its wallet, executes and
// releases the contributions to the developer, or expires the round so buyers reclaim their deposits.
import { createRequire } from 'node:module';
import { hash32 } from './algorithmic-picker.js';
import { designApartments, planApartmentBuildings } from './apartment-units.js';
import { apartmentDrawingPdf } from './apartment-drawing.js';
import { agreementObject, cidOfObject, deadlineAfterDays } from './agreement-objects.js';
import { mintAgreement, mintTermsOf } from './agreement-minter.js';
import { openAgreementMarket, usdcToAtomic } from './bettor.js';
import { listApartments } from './apartment-actions.js';
import { ensureBotUsdcFunding } from './funding.js';
import { cityMoney } from '../scripts/lib/frontend-city-money.mjs';

const require = createRequire(import.meta.url);
const agreementRecord = require('../../frontend/js/agreement-record.js');

const CLUSTER = 'devnet';
const MAX_UNITS = 8;

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

const decimal = (value, label) => {
    const text = String(value ?? '');
    if (!/^\d+(\.\d{1,6})?$/.test(text) || Number(text) <= 0) throw new Error(`${label} must be a positive decimal string, got ${JSON.stringify(value)}`);
    return text;
};
const share = (value, fallback, label) => {
    const number = value == null ? fallback : Number(value);
    if (!(number > 0 && number <= 1)) throw new Error(`${label} must be in (0, 1]`);
    return number;
};
// Whole cents of USDC as atomic units (1 USDC = 1 000 000).
const centsAtomic = atomic => (atomic / 10_000n) * 10_000n;

/** The persona's `developer` block, checked. */
export function developerConfig(persona) {
    const config = persona?.developer;
    if (!config || typeof config !== 'object') throw new Error(`${persona?.name} has no developer block`);
    if (!Array.isArray(config.plans) || !config.plans.length) throw new Error(`${persona.name} developer.plans lists no plan CIDs`);
    const units = Number(config.apartmentsPerRound ?? 6);
    if (!Number.isInteger(units) || units < 1 || units > MAX_UNITS) throw new Error(`${persona.name} developer.apartmentsPerRound must be 1-${MAX_UNITS}`);
    return {
        city: String(config.city || ''),
        plans: config.plans.map(String),
        projectPrefix: String(config.projectPrefix || config.city || 'project').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 20),
        maxOpenRounds: Math.max(1, Number(config.maxOpenRounds ?? 3)),
        deadlineDays: Number(config.deadlineDays ?? 4),
        apartmentsPerRound: units,
        plainRoundEvery: Math.max(0, Number(config.plainRoundEvery ?? 0)),
        plainTargetUsdc: decimal(config.plainTargetUsdc ?? '3', `${persona.name} developer.plainTargetUsdc`),
        priceUsdcPerM2: decimal(config.priceUsdcPerM2 ?? '0.05', `${persona.name} developer.priceUsdcPerM2`),
        depositShare: share(config.depositShare, 0.3, `${persona.name} developer.depositShare`),
        targetShare: share(config.targetShare, 0.6, `${persona.name} developer.targetShare`),
        lens: config.lens ? String(config.lens) : null
    };
}

/** The rounds this persona has built in earlier runs: [{ runId, key, cid, deadline, units: Set of 'project/unit' }]. */
export function earlierRounds(runs, personaName) {
    const rounds = [];
    for (const run of runs || []) {
        if (run?.persona !== personaName) continue;
        for (const [key, agreement] of Object.entries(run.summary?.agreements || {})) {
            if (agreement?.content?.rule?.electorate !== 'investors') continue;
            const apartments = agreement.content.funding?.apartments;
            rounds.push({ runId: run.run_id, key, cid: agreement.cid, deadline: agreement.deadline ?? agreement.content.deadline ?? null,
                minted: Boolean(run.summary?.mints?.[key]?.account), settled: Object.values(run.summary?.settlements || {}).some(row => row?.cid === agreement.cid && row.settled),
                units: new Set((apartments?.units || []).map(unit => `${apartments.projectId}/${unit.unitId}`)) });
        }
    }
    return rounds;
}

// A permanent inventory ID: the developer's project per plan building.
export function projectIdOf(prefix, designCid, buildingIndex) {
    return `${prefix}-${designCid.slice(-10)}-b${buildingIndex}`.toLowerCase();
}

/**
 * `count` apartments spread over the building's storeys, skipping units an earlier round offered,
 * starting at a seeded offset so successive rounds take different floors.
 */
export function chooseUnits(apartments, { count, seed, used = new Set(), projectId }) {
    const fresh = apartments.filter(apartment => !used.has(`${projectId}/${unitIdOf(apartment)}`));
    if (!fresh.length) return [];
    const take = Math.min(count, fresh.length);
    const step = fresh.length / take;
    const offset = hash32(seed) % Math.max(1, Math.floor(step));
    return Array.from({ length: take }, (_, i) => fresh[Math.min(fresh.length - 1, Math.floor(offset + i * step))]);
}

// The unit's permanent ID in the developer's inventory: its storey and its slot on that storey.
export function unitIdOf(apartment) {
    return `l${apartment.level}-${apartment.unitSlot}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64);
}

/** Price, deposit and target in atomic USDC from the unit's floor area and the persona's rates. */
export function roundAmounts(apartments, config) {
    const ratePerM2 = usdcToAtomic(config.priceUsdcPerM2);
    const units = apartments.map(apartment => {
        const price = centsAtomic(BigInt(Math.round(Number(apartment.areaM2) * 100)) * ratePerM2 / 100n);
        const deposit = centsAtomic(BigInt(Math.round(Number(price) * config.depositShare)));
        return { apartment, priceUsdcAtomic: String(price > 0n ? price : 10_000n), depositUsdcAtomic: String(deposit > 0n ? deposit : 10_000n) };
    });
    const deposits = units.reduce((sum, unit) => sum + BigInt(unit.depositUsdcAtomic), 0n);
    const target = centsAtomic(BigInt(Math.round(Number(deposits) * config.targetShare)));
    return { units, targetUsdcAtomic: String(target > 0n ? target : deposits) };
}

const usdcText = atomic => (Number(atomic) / 1e6).toFixed(2);

/** Signed transactions one round pick needs: mint, its listings (4 a transaction) and its market. */
export function roundSignedActions(candidate, { marketSeed = false } = {}) {
    return 1 + Math.ceil((candidate?.units?.length || 0) / 4) + (marketSeed ? 2 : 0);
}

/**
 * Plan and design readers over the index a round is published to; each object is checked against its
 * CID. → { loadPlan(cid) → { cid, content }, loadDesigns(cids) → [{ cid, content }] }
 */
export function createPlanReaders({ apiBase, index, fetchImpl = fetch }) {
    return {
        async loadPlan(cid) {
            const response = await fetchImpl(`${apiBase}/plans/${encodeURIComponent(cid)}`, { signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error(`plan ${cid} is not in the index at ${apiBase} (HTTP ${response.status})`);
            const body = await response.json();
            if (cidOfObject(body.content) !== cid) throw new Error(`the index served other content for plan ${cid}`);
            return { cid, content: body.content };
        },
        async loadDesigns(cids) {
            const rows = await index.getDesigns(cids);
            const missing = cids.filter(cid => !rows.has(cid));
            if (missing.length) throw new Error(`${missing.length} design(s) of the plan are not in the index: ${missing.slice(0, 3).join(', ')}`);
            return cids.map(cid => ({ cid, content: rows.get(cid).content }));
        }
    };
}

/** The investors' contract the round attaches (text/plain): what a contributor receives. */
export function roundContract({ planTitle, buildingTitle, developer, units, targetUsdcAtomic, deadline }) {
    const lines = [
        `Developer crowdfunding round: ${planTitle}${buildingTitle ? ` - ${buildingTitle}` : ''}`,
        '',
        `Developer (payout wallet): ${developer}`,
        `Funding target: ${usdcText(targetUsdcAtomic)} devnet USDC by ${deadline}.`,
        '',
        units.length
            ? 'Each apartment listed in this round has a fixed full price and reservation deposit, in devnet USDC. A buyer qualified by the round\'s lens member reserves one apartment by paying its deposit into the round\'s escrow. Only reservation deposits count toward the target.'
            : 'Any wallet may contribute devnet USDC to this round. Contributions count toward the target in the order the escrow records them.',
        units.length ? 'When the target is met and the lens member confirms, the deposits are released to the developer and each reservation stays with its buyer; the deposit is credited against the full price when the purchase contract is signed.'
            : 'When the target is met, the contributions are released to the developer, who reports progress on the plan to the contributors.',
        'If the round has not executed by its deadline, or the developer cancels it, every depositor reclaims their deposit from the escrow.',
        ...(units.length ? ['', 'Apartments:', ...units.map(unit => `- ${unit.label}: price ${usdcText(unit.priceUsdcAtomic)} USDC, deposit ${usdcText(unit.depositUsdcAtomic)} USDC`)] : [])
    ];
    return { name: 'round-terms.txt', mediaType: 'text/plain', data: Buffer.from(`${lines.join('\n')}\n`, 'utf8').toString('base64') };
}

/**
 * Plan this run's round, or none: { candidate } or { candidate: null, reason }. `loadPlan(cid)` →
 * { cid, content } and `loadDesigns(cids)` → [{ cid, content }] read the index the round is published to.
 */
export async function planRound({ persona, runs, runKey, now = Date.now(), loadPlan, loadDesigns, lensKeys = {} }) {
    const config = developerConfig(persona);
    const rounds = earlierRounds(runs, persona.name);
    const open = rounds.filter(round => !round.settled && round.deadline && Date.parse(round.deadline) > now);
    if (open.length >= config.maxOpenRounds) return { candidate: null, reason: `${open.length} round(s) still open (max ${config.maxOpenRounds})` };
    const number = rounds.length;
    const plain = config.plainRoundEvery > 0 && number % config.plainRoundEvery === config.plainRoundEvery - 1;
    const plan = await loadPlan(config.plans[number % config.plans.length]);
    const designs = await loadDesigns(plan.content.designCids || []);
    const base = { candidateId: `round-${number + 1}`, kind: 'round', city: config.city || plan.content.view?.city || null,
        planCid: plan.cid, planTitle: plan.content.title || plan.cid, deadlineDays: config.deadlineDays };
    if (plain) {
        return { candidate: { ...base, plain: true, lens: [], targetUsdcAtomic: String(usdcToAtomic(config.plainTargetUsdc)), units: [] } };
    }
    const used = new Set(rounds.flatMap(round => [...round.units]));
    const buildings = planApartmentBuildings(designs).filter(building => {
        const projectId = projectIdOf(config.projectPrefix, building.designCid, building.buildingIndex);
        return building.apartments.some(apartment => !used.has(`${projectId}/${unitIdOf(apartment)}`));
    });
    if (!buildings.length) return { candidate: null, reason: `plan ${plan.cid} has no residential building with apartments left to offer` };
    const building = buildings[hash32(`${runKey}:${persona.name}:${number}`) % buildings.length];
    const projectId = projectIdOf(config.projectPrefix, building.designCid, building.buildingIndex);
    const chosen = chooseUnits(building.apartments, { count: config.apartmentsPerRound, seed: `${runKey}:${persona.name}:units`, used, projectId });
    const { units, targetUsdcAtomic } = roundAmounts(chosen, config);
    const lensKey = config.lens ? (lensKeys[config.lens] || config.lens) : null;
    if (!lensKey) throw new Error(`${persona.name}: an apartment round needs developer.lens (a lens member that qualifies buyers)`);
    return { candidate: { ...base, plain: false, designCid: building.designCid, buildingIndex: building.buildingIndex, buildingTitle: building.title,
        projectId, lens: [lensKey], targetUsdcAtomic,
        units: units.map(({ apartment, priceUsdcAtomic, depositUsdcAtomic }) => ({
            unitId: unitIdOf(apartment), label: `Storey ${apartment.level}, flat ${apartment.ordinal} (${Math.round(apartment.areaM2)} m²)`,
            xrayBuilding: building.xrayBuilding, unit: apartment.unit, at: building.at, priceUsdcAtomic, depositUsdcAtomic
        })) } };
}

/**
 * The round's agreement/v1 content from its candidate: the funding terms with the attached contract
 * and, per unit, its drawing (regenerated from the design, apartment-drawing.js).
 */
export function roundAgreement({ candidate, plan, designs, developer, author, createdAt }) {
    const deadline = deadlineAfterDays(Date.parse(createdAt), candidate.deadlineDays);
    let apartments = null;
    if (candidate.units.length) {
        const design = designs.find(row => row.cid === candidate.designCid);
        if (!design) throw new Error(`design ${candidate.designCid} of plan ${candidate.planCid} is not in the index`);
        const laidOut = designApartments({ designCid: design.cid, content: design.content, buildingIndex: candidate.buildingIndex });
        const byKey = new Map(laidOut.apartments.map(apartment => [apartment.unit, apartment]));
        apartments = { projectId: candidate.projectId, units: candidate.units.map(unit => {
            const apartment = byKey.get(unit.unit);
            if (!apartment) throw new Error(`apartment ${unit.unit} is no longer in the layout of ${design.cid}`);
            const pdf = apartmentDrawingPdf({ apartment, label: unit.label, project: `${candidate.planTitle} - ${candidate.buildingTitle || design.cid}` });
            return { ...unit, drawing: { name: `${unit.unitId}.pdf`, mediaType: 'application/pdf', data: pdf.toString('base64') } };
        }) };
    }
    const funding = {
        targetUsdcAtomic: candidate.targetUsdcAtomic,
        contract: roundContract({ planTitle: candidate.planTitle, buildingTitle: candidate.buildingTitle, developer, units: apartments?.units || [], targetUsdcAtomic: candidate.targetUsdcAtomic, deadline }),
        ...(apartments ? { apartments } : {})
    };
    const title = apartments
        ? `${candidate.planTitle} · ${candidate.buildingTitle || 'building'} · ${apartments.units.length} apartments`
        : `${candidate.planTitle} · contribution round`;
    const rule = { electorate: 'investors', binding: true, lens: candidate.lens, approvalConfig: null, settlement: null };
    const { content, cid } = agreementObject({
        title: title.slice(0, 160), author, sponsor: developer, city: candidate.city, createdAt, plan,
        designs: designs.map(row => ({ cid: row.cid, goal: row.content?.goal, title: row.content?.title })),
        parcels: [], openGroundM2: 0, outputs: [], allocations: [],
        money: { currency: cityMoney(candidate.city).currentCurrency(), lines: [] }, valuation: null, rule, deadline, funding, requireSponsor: true
    });
    const error = agreementRecord.crowdfundingError(content, { requireSponsor: true });
    if (error) throw new Error(`round ${candidate.candidateId}: ${error}`);
    return { cid, content, title: content.title, deadline };
}

/**
 * One round pick through proposed → minted → recorded → listed → market (checkpoint maps in `state`,
 * saved through `save(stage, patch)` after each step; a rerun resumes at the first unfinished one).
 */
export async function advanceRound({
    pick, candidate, tag, persona, keypair, state, index, connection, run, save, loadPlan, loadDesigns, pool,
    marketSeedCapUsdc = 0, mintImpl = mintAgreement, listImpl = listApartments, openMarketImpl = openAgreementMarket,
    fundMarketSeed = ensureBotUsdcFunding, sendAndConfirm, now = () => new Date()
}) {
    const { agreements, mints, onchain } = state;
    const listings = state.listings ??= {};
    const markets = state.markets ??= {};
    const marketFunding = state.marketFunding ??= {};
    const key = pick.candidateId;
    const wallet = keypair.publicKey.toBase58();
    const entity = cid => ({ entity: { type: 'agreement', id: cid } });
    if (!agreements[key]) {
        const plan = await loadPlan(candidate.planCid);
        const designs = await loadDesigns(plan.content.designCids || []);
        const built = roundAgreement({ candidate, plan, designs, developer: wallet, author: persona.name, createdAt: now().toISOString() });
        agreements[key] = { ...built, plan, lamports: '0', soleOwner: false };
        await save(null, { agreements });
        log(`${tag} round built: ${built.cid} · target ${usdcText(candidate.targetUsdcAtomic)} USDC · ${candidate.units.length} apartment(s) · deadline ${built.deadline}`);
    }
    if (!agreements[key].indexedAt) {
        const agreement = agreements[key];
        const published = await run({ type: 'propose', agreementCid: agreement.cid, pickId: pick.pickId },
            () => index.publishAgreement(agreement.content, { plan: agreement.plan }),
            { ...entity(agreement.cid), message: `${persona.name} opened the crowdfunding round "${agreement.title}".` });
        agreements[key] = { ...agreement, indexedAt: now().toISOString(), status: published.row.status ?? null };
        await save('proposed', { agreements });
        log(`${tag} round ${published.created ? 'indexed' : 'already indexed'}: ${agreement.cid}`);
    }
    if (!mints[key]) {
        const agreement = agreements[key];
        await index.pinForMint(agreement.cid);
        const minted = await run({ type: 'mint', agreementCid: agreement.cid, lamports: '0', lens: agreement.content.rule.lens, pickId: pick.pickId },
            () => mintImpl({ connection, sponsorKeypair: keypair, cid: agreement.cid, ...mintTermsOf(agreement.content),
                deadline: agreement.deadline, lamports: 0n, openGround: false, sendAndConfirm }),
            { ...entity(agreement.cid), message: `${persona.name} minted the crowdfunding round "${agreement.title}" on Solana devnet.` });
        mints[key] = { ...minted, cluster: CLUSTER, mintedAt: now().toISOString() };
        await save('minted', { mints });
        log(`${tag} round minted: ${minted.account}${minted.created ? '' : ' (already created)'} · tx ${minted.signature ?? 'none needed'}`);
    }
    if (!onchain[key]) {
        await index.recordOnchain(agreements[key].cid, { cluster: CLUSTER, account: mints[key].account, signature: mints[key].createSignature });
        onchain[key] = { account: mints[key].account, signature: mints[key].createSignature, recordedAt: now().toISOString() };
        await save('recorded', { onchain });
    }
    if (candidate.units.length && !listings[key]) {
        const agreement = agreements[key];
        const listed = await run({ type: 'list-apartments', agreementCid: agreement.cid, pickId: pick.pickId },
            () => listImpl({ connection, developerKeypair: keypair, account: mints[key].account, content: agreement.content, sendAndConfirm }),
            { ...entity(agreement.cid), message: `${persona.name} listed ${candidate.units.length} apartments for reservation in "${agreement.title}".` });
        listings[key] = { ...listed, listedAt: now().toISOString() };
        await save(null, { listings });
        log(`${tag} listed ${listed.listed} apartment(s)${listed.alreadyListed ? `, ${listed.alreadyListed} already listed` : ''}`);
    }
    if (marketSeedCapUsdc > 0 && !markets[key]) {
        const agreement = agreements[key];
        const opened = await run({ type: 'openMarket', agreementCid: agreement.cid, pickId: pick.pickId },
            () => openMarketImpl({ connection, sponsorKeypair: keypair, subject: mints[key].account,
                maxSeedAtomic: usdcToAtomic(String(marketSeedCapUsdc)), sendAndConfirm,
                ensureSeed: async requiredAtomic => {
                    const funding = await fundMarketSeed({ connection, persona, pool, requiredAtomic, maxActionAtomic: usdcToAtomic(String(marketSeedCapUsdc)), sendAndConfirm });
                    if (funding.status === 'funded') { marketFunding[key] = funding; await save(null, { marketFunding }); }
                    return funding;
                } }),
            { ...entity(agreement.cid), message: `${persona.name} opened the market for ${agreement.title}.` });
        markets[key] = { ...opened, openedAt: now().toISOString() };
        await save(null, { markets });
        log(`${tag} market opened: ${opened.address} · seed ${opened.seedAtomic} atomic devnet USDC`);
    }
    return { done: Boolean(onchain[key]) && (!candidate.units.length || Boolean(listings[key])) && (marketSeedCapUsdc <= 0 || Boolean(markets[key])) };
}
