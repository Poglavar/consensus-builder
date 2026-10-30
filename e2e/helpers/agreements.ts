// Agreements from the screen, shared by the agreement specs: a parcel layout applied over one owned
// parcel (the design an agreement settles), the agreement editor (Create / Edit agreement over a
// saved plan), the agreement panel in the click stack and the Lists panel's Agreements tab
// (frontend/js/agreement-dialog.js, agreement-panel.js, lists-panel.js). Also the
// agreements other specs start from: one filed in the index as another device proposed it (minted,
// with its pool, when asked), and one proposed from this device over a park applied here.
import { expect, Locator, Page } from '@playwright/test';
import { createSpace, expandStackSection, openCity, openParcel, PARCEL_ID } from './runtime';
import { fileAgreement, fileDesign, filePlan, pageIndex, MarketFixture, SharedIndex } from './mocks/shared-server';

export const OWNER = 'Ana Owner';

// ---- agreements the specs start from ------------------------------------------------------------

// The parcel a filed agreement settles, the account it is minted at, and its sponsor.
export const FILED_PARCEL = 'HR-335614-2311';
export const MINTED_ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
export const MINTED_SPONSOR = 'AoVsGaj8MSJ6xwKxfFxo9iZWH3enC8RRTXKH2fx2F8os';
export const OPEN_POOL: MarketFixture = {
  address: 'HQqbGtviQr5KRs4x8CWSCVhnkrLKDiYqXmVSBY8GZdfw', model: 'lmsr', asset: 'devnet-usdc',
  creator: MINTED_SPONSOR, b: '100000000', qYes: '250000', qNo: '50000', seed: '69314720',
  closesAt: Math.floor(Date.parse('2026-12-31T00:00:00.000Z') / 1000), graceSeconds: 0, maxPosition: '0',
  paidOut: '0', resolved: false, outcome: null,
};

/** Seed the wallet-backed browser specs into their explicit devnet-USDC book before app startup. */
export async function selectDevnetUsdc(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('bets-asset-v1', 'devnet-usdc'));
}

// The chain record the index keeps of a minted agreement (POST /agreements/:cid/onchain): `status`
// as the index observed it (null: not observed), `decision` the lens's.
export interface MintedRecord { account?: string; sponsor?: string; status?: string | null; decision?: string }

export interface FiledAgreement {
  title: string | null;
  author?: string;
  createdAt?: string;
  deadline?: string | null;
  /** Its designs, filed beside it as parks; one named after the agreement by default. */
  designTitles?: string[];
  /** A community vote; otherwise a binding owners' agreement. */
  community?: boolean;
  /** Minted: the index records its chain account (MINTED_ACCOUNT unless given). */
  minted?: MintedRecord | null;
  /** The agreement's LMSR market in the mocked index. */
  pool?: MarketFixture | null;
  /** Fields of the index row itself, such as its rendered pictures. */
  row?: Record<string, any>;
  areaM2?: number;
}

const onchainRecord = (minted: MintedRecord) => ({
  chain: 'solana', cluster: 'devnet', account: minted.account || MINTED_ACCOUNT, sponsor: minted.sponsor || MINTED_SPONSOR,
  status: minted.status === undefined ? 'active' : minted.status, decision: minted.decision || 'pending',
});

/**
 * An agreement over FILED_PARCEL proposed in Zagreb from another device, as the index holds it: its
 * designs filed beside it, its chain record when minted, and its pool when one is open.
 */
export function fileIndexedAgreement(index: SharedIndex, options: FiledAgreement): { cid: string; designCid: string; designCids: string[] } {
  const { title, author = 'densifier-01', createdAt = '2026-10-01T09:30:00.000Z', community = false, minted = null, pool = null, row = {}, areaM2 = 120 } = options;
  // A minted market is dated. Keep its question deadline identical to its market cutoff.
  const deadline = options.deadline ?? (minted ? '2026-12-31T00:00:00.000Z' : null);
  const designs = (options.designTitles || [`${title} park`]).map(designTitle => ({
    cid: fileDesign(index, {
      schema: 'design/v1', goal: 'park', title: designTitle, description: null, author, city: 'zagreb', site: null, toleranceM: null,
      geometry: null, origin: null, authoredAt: createdAt, structureProposal: { kind: 'park', blockName: null },
    }, { createdAt }),
    goal: 'park', title: designTitle,
  }));
  const planContent = { schema: 'plan/v1', title: title || 'Untitled plan', designCids: designs.map(design => design.cid).sort(),
    view: { at: '45.8,15.96,16', mode: '2d', city: 'zagreb', language: 'en' } };
  const planCid = filePlan(index, planContent);
  const onchain = minted ? onchainRecord(minted) : null;
  const cid = fileAgreement(index, {
    schema: 'agreement/v1', title, author, sponsor: onchain ? onchain.sponsor : null, city: 'zagreb', createdAt, planCid,
    inputs: { parcels: [{ parcelId: FILED_PARCEL, areaM2 }], openGroundM2: 0 },
    outputs: [], allocations: [], money: { currency: 'EUR', lines: [] },
    rule: community
      ? { electorate: 'community', binding: false, approvalConfig: null, lens: [] }
      : { electorate: 'owners', binding: true, approvalConfig: null, lens: [] },
    deadline,
  }, { createdAt, ...(onchain ? { onchain } : {}), ...row });
  if (onchain && pool) index.markets.set(onchain.account, {
    ...pool, closesAt: deadline ? Math.floor(Date.parse(deadline) / 1000) : pool.closesAt,
  });
  return { cid, designCid: designs[0].cid, designCids: designs.map(design => design.cid) };
}

/**
 * An agreement over a park applied here, proposed from this device: the park drawn and marked
 * published as its design, the agreement stored as published (its land derived as the editor
 * derives it), both filed in the index under the CIDs the browser computed. A community vote unless
 * `minted` is given: then a binding owners' agreement with MINTED_SPONSOR, the index recording its
 * chain account and `pool`.
 */
export async function proposeOverPark(page: Page, { title, author = 'Fixture author', minted = null, pool = null }:
  { title: string; author?: string; minted?: MintedRecord | null; pool?: MarketFixture | null }): Promise<{ id: string; cid: string; designCid: string; parkId: string; parkTitle: string }> {
  const parkId = await createSpace(page, 'park');
  const onchain = minted ? onchainRecord(minted) : null;
  const seeded = await page.evaluate(async ({ parkId, title, author, sponsor }) => {
    const w = window as any;
    const design = w.proposalStorage.getProposal(parkId);
    const designCid = w.DesignRecord.cidOf(design);
    const planContent = w.PlanRecord.create(title, [designCid], w.MapShare.capture(w));
    const plan = { cid: w.Cid.cidOfObject(planContent), content: planContent };
    const createdAt = new Date().toISOString();
    const apiBase = w.DesignSync.apiBase();
    w.DesignSync.markPublished(design, { cid: designCid, publishedAt: createdAt, apiBase });
    const fabric = w.LiveParcelFabric;
    const ground = w.AgreementGround;
    const ids = w.AgreementDialog.inputParcelIds([design], fabric);
    const originals = (await w.CadastralParcelRepository.ensureIds(ids, { retainOnly: true })).features || [];
    const land = ground.derive({
      designs: [design], fabric, originals: w.AgreementDialog.originalsById(originals, fabric.featureId),
      area: (feature: any) => w.turf.area(feature),
    });
    const record = {
      schema: 'agreement/v1', id: w.AgreementRecord.newId(), title, city: w.CityConfigManager.getCurrentCityId(), createdAt,
      plan,
      designs: [{ proposalId: parkId, title: design.title, goal: design.goal, cid: designCid }],
      inputs: land.inputs, outputs: land.outputs, allocations: [], money: { currency: 'EUR', lines: [] },
      rule: sponsor
        ? { electorate: 'owners', binding: true, approvalConfig: null, lens: [] }
        : { electorate: 'community', binding: false, approvalConfig: null, lens: [] },
      deadline: sponsor ? '2026-12-31T00:00:00.000Z' : null,
    };
    const content = w.AgreementRecord.published({ ...record, author, sponsor });
    const cid = w.Cid.cidOfObject(content);
    const saved = w.AgreementStore.save({ ...record, published: { cid, publishedAt: createdAt, apiBase, sponsor } });
    return { id: String(saved.id), cid, designCid, content, plan, parkTitle: String(design.title), design: JSON.parse(JSON.stringify(w.DesignRecord.published(design))) };
  }, { parkId, title, author, sponsor: onchain ? onchain.sponsor : null });
  const index = pageIndex(page);
  // The browser's CIDs are the CIDs of the objects' canonical bytes (node's own computation).
  expect(fileDesign(index, seeded.design)).toBe(seeded.designCid);
  expect(filePlan(index, seeded.plan.content)).toBe(seeded.plan.cid);
  expect(fileAgreement(index, seeded.content, onchain ? { onchain } : {})).toBe(seeded.cid);
  if (onchain && pool) index.markets.set(onchain.account, pool);
  return { id: seeded.id, cid: seeded.cid, designCid: seeded.designCid, parkId, parkTitle: seeded.parkTitle };
}

// Parcel 1234 held by one local owner, laid out into two equal plots and applied: the design an
// agreement settles. The owner record is written first, so the layout carries it over to the plots.
// `ownerKey` is that local owner (a person in the rights snapshot); `partyKey` is the parcel's
// abstract party, parcel-owner:<id>, which agreements allocate to and pay (AgreementRecord.partyKey).
export async function applyLayout(page: Page): Promise<{ layoutId: string; ownerKey: string; partyKey: string }> {
  await openCity(page);
  const ownerKey = await page.evaluate(async ({ parcelId, name }) => {
    const w = window as any;
    await w.i18n.setLanguage('en');
    const agent = w.createAgent();
    agent.name = name;
    w.agentStorage.addAgent(agent);
    w.PersistentStorage.setItem(`parcel_${parcelId}_owner`, agent.id);
    return String(agent.id);
  }, { parcelId: PARCEL_ID, name: OWNER });
  const layoutId = await layOutParcel(page, PARCEL_ID);
  const partyKey = await page.evaluate(id => String((window as any).AgreementRecord.partyKey(id)), PARCEL_ID);
  return { layoutId, ownerKey, partyKey };
}

// "Lay out parcels" on one more parcel from its Propose here menu, Done on the default equal plots;
// returns the new layout's id.
export async function layOutParcel(page: Page, parcelId: string): Promise<string> {
  const before: string[] = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.goal === 'parcel-layout').map((proposal: any) => String(proposal.proposalId)));
  await page.evaluate(async id => { await (window as any).CadastralParcelRepository.ensureIds([id]); }, parcelId);
  await expect.poll(() => page.evaluate(id => !!(window as any).ParcelPresenter.getLayer(id), parcelId), { timeout: 30_000 }).toBe(true);
  await openParcel(page, 'proposals', parcelId);
  await page.locator('.parcel-build-btn--parcel-layout').click();
  const editor = page.locator('.on-map-reparcellization');
  const done = editor.locator('[data-reparcel-commit]');
  await expect(done).toBeEnabled({ timeout: 15_000 });
  await done.click();
  await expect(editor).toHaveCount(0);
  const appliedLayouts = () => page.evaluate(known => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.applied && proposal.goal === 'parcel-layout' && !known.includes(String(proposal.proposalId)))
    .map((proposal: any) => String(proposal.proposalId)), before);
  await expect.poll(async () => (await appliedLayouts()).length, { timeout: 30_000 }).toBe(1);
  return (await appliedLayouts())[0];
}

export const agreementEditor = (page: Page) => page.locator('section#agreement-editor');
export const agreementPanel = (page: Page) => page.locator('section#agreement-panel');
export const storedAgreements = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).AgreementStore.list())));
export const editorSave = (editor: Locator) => editor.locator('[data-agreement-action="save"]');
// The footer's Cancel (the header's close button is the other [data-agreement-action="cancel"]).
export const editorCancel = (editor: Locator) => editor.locator('.agreement-editor__footer [data-agreement-action="cancel"]');
export const editorClose = (editor: Locator) => editor.locator('.panel-header [data-agreement-action="cancel"]');

// The editor open with `title` in its header. Its designs are the saved plan's, so it picks nothing
// on the map.
export async function editorOpen(page: Page, title: 'Create agreement' | 'Edit agreement'): Promise<Locator> {
  const editor = agreementEditor(page);
  await expect(editor).toBeVisible();
  await expect(editor.locator('#agreement-editor-title')).toHaveText(title);
  await expect(page.locator('body')).toHaveClass(/\bagreement-editor-open\b/);
  return editor;
}

// The editor closed: off the dock, and the map no longer picks for it.
export async function editorClosed(page: Page): Promise<void> {
  await expect(agreementEditor(page)).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/\bagreement-editor-open\b/);
  await expect(page.locator('body')).not.toHaveClass(/\bmap-pick-mode\b/);
  expect(await page.evaluate(() => (window as any).MapPick.active())).toBeNull();
}

// Agreement creation belongs to a saved plan: the design is saved into a new plan, and the plan's
// Create agreement in the click stack opens the editor on a new agreement over that plan's land.
export async function createFromPlan(page: Page, layoutId: string, planTitle = 'Agreement plan'): Promise<Locator> {
  await page.evaluate(id => { const w = window as any; void w.PlanDialog.create({ members: [w.proposalStorage.getProposal(id)] }); }, layoutId);
  const composer = page.locator('.plan-dialog');
  await composer.locator('input[type="text"]').fill(planTitle);
  await composer.getByRole('button', { name: 'Create plan', exact: true }).click();
  await page.locator('#click-stack .click-stack__section[data-kind="plans"]').getByRole('button', { name: 'Create agreement', exact: true }).click();
  const editor = await editorOpen(page, 'Create agreement');
  await expect(editor.locator('[data-agreement-input]')).toHaveCount(1, { timeout: 30_000 });
  return editor;
}

// The Lists panel on its Agreements tab: this device's drafts and the city's agreements in the index,
// with their chain status, one row per agreement (a published one stored here under its local id).
export async function openAgreementsList(page: Page): Promise<Locator> {
  const sheet = page.locator('#proposals-sheet');
  if (!(await sheet.isVisible())) await page.locator('#proposals-button').click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('tab', { name: 'Agreements', exact: true }).click();
  const list = sheet.locator('#designs-agreements');
  await expect(list).toBeVisible();
  return list;
}

// Saving a new agreement from a plan keeps the plan the open section of the click stack; the new
// agreement waits in the stack's Agreements section, whose row opens its panel, current.
export async function openStackAgreement(page: Page): Promise<Locator> {
  await expandStackSection(page, 'agreements');
  await panelStatus(page, 'current');
  return agreementPanel(page);
}

// The agreement panel lives in the click stack, which has no × of its own: Escape closes the spot.
export async function closeAgreementPanel(page: Page): Promise<void> {
  await page.locator('body').press('Escape');
  await expect(agreementPanel(page)).toBeHidden();
}

// A row of the Agreements list: an agreement here by its id, one in the index by its CID.
export const agreementListItem = (list: Locator, key: string) => list.locator(`.lists-item[data-list-id="${key}"]`);
// Inspect a listed agreement: its title button opens its panel and closes the Lists panel.
export const openListedAgreement = (list: Locator, key: string) => agreementListItem(list, key).locator('.lists-item__open').click();

// The panel on the right dock once its check against the map reached `status`. A matching agreement
// shows no status at all; one that does not match shows the warning, which is returned.
export async function panelStatus(page: Page, status: 'current' | 'stale'): Promise<Locator> {
  const panel = agreementPanel(page);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-agreement-check', status, { timeout: 30_000 });
  const warning = panel.locator('[data-agreement-status]');
  if (status === 'stale') await expect(warning).toBeVisible();
  else await expect(warning).toHaveCount(0);
  return warning;
}
