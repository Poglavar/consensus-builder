// Agreements from the screen, shared by the agreement specs: a parcel layout applied over one owned
// parcel (the design an agreement settles), the agreement editor docked on the right of the map
// (Create / Edit agreement, which picks designs on the map), the docked agreement panel and the
// Agreements list (frontend/js/agreement-dialog.js, agreement-panel.js, agreement-list.js). Also the
// agreements other specs start from: one filed in the index as another device proposed it (minted,
// with its pool, when asked), and one proposed from this device over a park applied here.
import { expect, Locator, Page } from '@playwright/test';
import { createSpace, openCity, openParcel, showProposal, PARCEL_ID } from './runtime';
import { fileAgreement, fileDesign, pageIndex, MarketPool, SharedIndex } from './mocks/shared-server';

export const OWNER = 'Ana Owner';

// ---- agreements the specs start from ------------------------------------------------------------

// The parcel a filed agreement settles, the account it is minted at, its sponsor, and an open pool.
export const FILED_PARCEL = 'HR-335614-2311';
export const MINTED_ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
export const MINTED_SPONSOR = 'AoVsGaj8MSJ6xwKxfFxo9iZWH3enC8RRTXKH2fx2F8os';
export const OPEN_POOL: MarketPool = { address: 'HQqbGtviQr5KRs4x8CWSCVhnkrLKDiYqXmVSBY8GZdfw', yesPool: '250000', noPool: '50000' };

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
  /** The market pool the chain holds for its account. */
  pool?: MarketPool | null;
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
  const { title, author = 'densifier-01', createdAt = '2026-10-01T09:30:00.000Z', deadline = null, community = false, minted = null, pool = null, row = {}, areaM2 = 120 } = options;
  const designs = (options.designTitles || [`${title} park`]).map(designTitle => ({
    cid: fileDesign(index, {
      schema: 'design/v1', goal: 'park', title: designTitle, description: null, author, city: 'zagreb', site: null, toleranceM: null,
      geometry: null, origin: null, authoredAt: createdAt, structureProposal: { kind: 'park', blockName: null },
    }, { createdAt }),
    goal: 'park', title: designTitle,
  }));
  const onchain = minted ? onchainRecord(minted) : null;
  const cid = fileAgreement(index, {
    schema: 'agreement/v1', title, author, sponsor: onchain ? onchain.sponsor : null, city: 'zagreb', createdAt, designs,
    inputs: { parcels: [{ parcelId: FILED_PARCEL, areaM2, holders: [] }], openGroundM2: 0 },
    outputs: [], allocations: [], money: { currency: 'EUR', lines: [] },
    rule: community
      ? { electorate: 'community', binding: false, approvalConfig: null, lens: [] }
      : { electorate: 'owners', binding: true, approvalConfig: null, lens: [] },
    deadline,
  }, { createdAt, ...(onchain ? { onchain } : {}), ...row });
  if (onchain && pool) index.markets.set(onchain.account, pool);
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
  { title: string; author?: string; minted?: MintedRecord | null; pool?: MarketPool | null }): Promise<{ id: string; cid: string; designCid: string; parkId: string; parkTitle: string }> {
  const parkId = await createSpace(page, 'park');
  const onchain = minted ? onchainRecord(minted) : null;
  const seeded = await page.evaluate(async ({ parkId, title, author, sponsor }) => {
    const w = window as any;
    const design = w.proposalStorage.getProposal(parkId);
    const designCid = w.DesignRecord.cidOf(design);
    const createdAt = new Date().toISOString();
    const apiBase = w.DesignSync.apiBase();
    w.DesignSync.markPublished(design, { cid: designCid, publishedAt: createdAt, apiBase });
    const fabric = w.LiveParcelFabric;
    const ground = w.AgreementGround;
    const ids = w.AgreementDialog.inputParcelIds([design], fabric);
    const originals = (await w.CadastralParcelRepository.ensureIds(ids, { retainOnly: true })).features || [];
    const land = ground.derive({
      designs: [design], fabric, originals: w.AgreementDialog.originalsById(originals, fabric.featureId),
      ownerOf: ground.localHolders({ storage: w.PersistentStorage, agents: w.agentStorage }), area: (feature: any) => w.turf.area(feature),
    });
    const record = {
      schema: 'agreement/v1', id: w.AgreementRecord.newId(), title, city: w.CityConfigManager.getCurrentCityId(), createdAt,
      designs: [{ proposalId: parkId, title: design.title, goal: design.goal, cid: designCid }],
      inputs: land.inputs, outputs: land.outputs, allocations: [], money: { currency: 'EUR', lines: [] },
      rule: sponsor
        ? { electorate: 'owners', binding: true, approvalConfig: null, lens: [] }
        : { electorate: 'community', binding: false, approvalConfig: null, lens: [] },
      deadline: null,
    };
    const content = w.AgreementRecord.published({ ...record, author, sponsor });
    const cid = w.Cid.cidOfObject(content);
    const saved = w.AgreementStore.save({ ...record, published: { cid, publishedAt: createdAt, apiBase, sponsor } });
    return { id: String(saved.id), cid, designCid, content, parkTitle: String(design.title), design: JSON.parse(JSON.stringify(w.DesignRecord.published(design))) };
  }, { parkId, title, author, sponsor: onchain ? onchain.sponsor : null });
  const index = pageIndex(page);
  // The browser's CIDs are the CIDs of the objects' canonical bytes (node's own computation).
  expect(fileDesign(index, seeded.design)).toBe(seeded.designCid);
  expect(fileAgreement(index, seeded.content, onchain ? { onchain } : {})).toBe(seeded.cid);
  if (onchain && pool) index.markets.set(onchain.account, pool);
  return { id: seeded.id, cid: seeded.cid, designCid: seeded.designCid, parkId, parkTitle: seeded.parkTitle };
}

// Parcel 1234 held by one local owner, laid out into two equal plots and applied: the design an
// agreement settles. The owner record is written first, so the layout carries it over to the plots.
export async function applyLayout(page: Page): Promise<{ layoutId: string; ownerKey: string }> {
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
  return { layoutId, ownerKey };
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

// The land under the chosen designs, once it is read: input parcels and the pieces standing on them.
export async function landLoaded(editor: Locator): Promise<void> {
  await expect(editor.locator('table[data-agreement-inputs] tr[data-agreement-input]').first()).toBeVisible({ timeout: 30_000 });
  await expect(editor.locator('[data-agreement-land-loading]')).toHaveCount(0);
  await expect(editor.locator('table[data-agreement-outputs] tr[data-agreement-output]').first()).toBeVisible();
}

// The editor docked and picking on the map, with `title` in its header.
export async function editorOpen(page: Page, title: 'Create agreement' | 'Edit agreement'): Promise<Locator> {
  const editor = agreementEditor(page);
  await expect(editor).toBeVisible();
  await expect(editor.locator('#agreement-editor-title')).toHaveText(title);
  await expect(page.locator('body')).toHaveClass(/\bagreement-editor-open\b/);
  await expect.poll(() => page.evaluate(() => (window as any).MapPick.active())).toBe('agreement');
  return editor;
}

// The editor closed: off the dock, and the map no longer picks for it.
export async function editorClosed(page: Page): Promise<void> {
  await expect(agreementEditor(page)).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/\bagreement-editor-open\b/);
  await expect(page.locator('body')).not.toHaveClass(/\bmap-pick-mode\b/);
  expect(await page.evaluate(() => (window as any).MapPick.active())).toBeNull();
}

// The details panel's Add to agreement, with no agreement waiting to be proposed: the editor opens on
// a new agreement over that one design.
export async function createFromDetails(page: Page, layoutId: string): Promise<Locator> {
  await showProposal(page, layoutId);
  const add = page.locator('#proposal-details-panel .btn-create-agreement');
  await expect(add).toHaveText('Add to agreement');
  await add.click();
  const editor = await editorOpen(page, 'Create agreement');
  await expect(editor.locator(`input[data-agreement-design="${layoutId}"]`)).toBeChecked();
  await landLoaded(editor);
  return editor;
}

// The Agreements button sits in the Proposals sheet, under Proposal tools; so does Minted agreements.
async function openProposalTools(page: Page): Promise<void> {
  const sheet = page.locator('#proposals-sheet');
  if (!(await sheet.isVisible())) await page.locator('#proposals-button').click();
  await expect(sheet).toBeVisible();
  await expect(page.locator('#proposal-list-actions')).toBeVisible();
}

export async function openAgreementsList(page: Page): Promise<Locator> {
  await openProposalTools(page);
  await page.locator('#agreementsButton').click();
  const list = page.locator('.agreement-list-dialog');
  await expect(list).toBeVisible();
  return list;
}

export async function openMintedAgreements(page: Page): Promise<Locator> {
  await openProposalTools(page);
  await page.locator('#mintedAgreementsButton').click();
  const list = page.locator('.agreement-minted-dialog');
  await expect(list).toBeVisible();
  return list;
}

// The panel on the right dock and the status it reached against the map.
export async function panelStatus(page: Page, status: 'current' | 'stale'): Promise<Locator> {
  await expect(agreementPanel(page)).toBeVisible();
  const badge = agreementPanel(page).locator(`[data-agreement-status="${status}"]`);
  await expect(badge).toBeVisible({ timeout: 30_000 });
  return badge;
}
