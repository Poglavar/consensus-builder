// Purpose: proposing an agreement from the screen (plan-design-agreement.md, M2 "Browser"): Propose on
// the agreement panel asks a guest for a profile name, then indexes the parcel layout (POST /designs)
// and the agreement/v1 object with its plan carried along (POST /agreements), pinning nothing; the panel then shows it Proposed under its CID and no longer offers Edit, and
// the /agreements/<cid> link imports the agreement and its design on another device.
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { fillNativeDateTime } from '../helpers/controls';
import { chooseProfileName, openOnAnotherDevice, stubBasemapTiles, PARCEL_ID } from '../helpers/runtime';
import {
  applyLayout, agreementPanel, storedAgreements, createFromPlan, openStackAgreement, openAgreementsList, openListedAgreement, closeAgreementPanel, panelStatus, editorSave, editorClosed,
} from '../helpers/agreements';
import { canonicalJson, cidOfBytes, cidOfObject, pageIndex, SharedIndex } from '../helpers/mocks/shared-server';

test.beforeEach(async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
});

const TITLE = 'Block 1234 proposed';
const AUTHOR = 'Agreement author';
const postsOf = (index: SharedIndex) => index.requests.filter(request => request.method === 'POST');

test('Propose publishes a community agreement with its parcel layout, and its link opens it on another device @core', async ({ mockApi: page, browser, baseURL }) => {
  test.setTimeout(300_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const { layoutId } = await applyLayout(page);
  const index = pageIndex(page);

  const editor = await createFromPlan(page, layoutId);
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await editor.locator('input[name="agreement-electorate"][value="community"]').check();
  await editor.locator('[data-agreement-title]').fill(TITLE);
  await fillNativeDateTime(editor.locator('[data-agreement-deadline]'), '2030-12-31');
  await editorSave(editor).click();
  await editorClosed(page);
  const panel = await openStackAgreement(page);
  const propose = panel.locator('[data-agreement-action="propose"]');
  await expect(propose).toHaveClass(/\bbtn-primary\b/);
  await expect(panel.locator('[data-agreement-action="edit"]')).toBeVisible();
  const [draft] = await storedAgreements(page);
  expect(draft.published).toBeNull();

  // A guest chooses a profile name first: the agreement carries its author, and nothing was sent.
  await propose.click();
  await chooseProfileName(page, AUTHOR);
  expect(postsOf(index)).toEqual([]);
  await panelStatus(page, 'current');
  await panel.locator('[data-agreement-action="propose"]').click();

  // The panel says Proposed, under the agreement's CID, with the index's status, and is no longer edited.
  const cidCode = panel.locator('code.agreement-panel-cid');
  await expect(cidCode).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('[data-agreement-remote-status="active"]')).toHaveText('Active', { timeout: 30_000 });
  await expect(panel.locator('[data-agreement-community-note]')).toBeVisible();
  await expect(panel.locator('[data-agreement-action="edit"]')).toHaveCount(0);
  await expect(panel.locator('[data-agreement-action="propose"]')).toHaveCount(0);
  // A vote binds nobody, so it is never minted: the chain section says so and offers no chain action.
  await expect(panel.locator('[data-agreement-chain="non-binding"]')).toHaveText('A vote is not minted; its decisions are counted off-chain.');
  await expect(panel.locator('[data-agreement-action="mint"], [data-agreement-action="repropose"], [data-agreement-action="bet"]')).toHaveCount(0);

  // Indexed, nothing pinned: the layout, then the agreement with its plan; each under the CID of its
  // canonical bytes.
  const posts = postsOf(index);
  expect(posts.map(request => request.path)).toEqual(['/designs', '/agreements']);
  const [designIndexed, indexed] = posts;
  const layoutCid = designIndexed.body.cid;
  const cid = indexed.body.cid;
  const planCid = indexed.body.plan.cid;
  expect(cidOfBytes(Buffer.from(canonicalJson(designIndexed.body.content), 'utf8'))).toBe(layoutCid);
  expect(designIndexed.body.content).toMatchObject({ schema: 'design/v1', goal: 'parcel-layout', author: AUTHOR });
  expect(cidOfBytes(Buffer.from(canonicalJson(indexed.body.plan.content), 'utf8'))).toBe(planCid);
  expect(indexed.body.plan).toMatchObject({ content: { schema: 'plan/v1', designCids: [layoutCid] } });
  expect(cidOfBytes(Buffer.from(canonicalJson(indexed.body.content), 'utf8'))).toBe(cid);
  expect(cidOfObject(indexed.body.content)).toBe(cid);
  expect(indexed.body).not.toHaveProperty('designs');
  await expect(cidCode).toHaveAttribute('title', cid);
  expect(await page.evaluate(id => {
    const w = window as any;
    return w.DesignRecord.cidOf(w.proposalStorage.getProposal(id));
  }, layoutId)).toBe(layoutCid);

  // The agreement names its immutable plan; land and pieces use hashes without geometry.
  const content = indexed.body.content;
  const [saved] = await storedAgreements(page);
  expect(content).toMatchObject({
    schema: 'agreement/v1', title: TITLE, author: AUTHOR, sponsor: null,
    planCid,
    rule: { electorate: 'community', binding: false },
  });
  expect(content).not.toHaveProperty('designs');
  expect(content).not.toHaveProperty('designCids');
  expect(content.inputs.parcels.map((parcel: any) => parcel.parcelId)).toEqual([PARCEL_ID]);
  expect(content.outputs.map((output: any) => output.hash)).toEqual(saved.outputs.map((output: any) => output.hash));
  content.outputs.forEach((output: any) => expect(output).not.toHaveProperty('geometry'));
  expect(Date.parse(content.deadline)).toBe(Date.parse(saved.deadline));

  // The device keeps both as published, and the link is on the clipboard (Copy link copies it again).
  expect(saved.published).toMatchObject({ cid });
  expect(saved.designs).toEqual([expect.objectContaining({ proposalId: layoutId, cid: layoutCid })]);
  expect(await page.evaluate(id => (window as any).DesignSync.publishedCid((window as any).proposalStorage.getProposal(id)), layoutId)).toBe(layoutCid);
  expect([...index.designs.keys()]).toEqual([layoutCid]);
  expect([...index.agreements.keys()]).toEqual([cid]);
  const link = `${new URL(page.url()).origin}/agreements/${cid}?city=zg&lang=en`;
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await panel.locator('[data-agreement-action="link"]').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  expect(postsOf(index)).toHaveLength(2);

  // Another device opens the link: the agreement and its layout come from the index, the layout is
  // applied, the pieces re-derive to the published hashes, and the panel opens on it, current.
  const receiver = await openOnAnotherDevice(browser, `/agreements/${cid}?city=zg&reduceMotion=1`, index, baseURL);
  try {
    const remotePanel = agreementPanel(receiver.page);
    await expect(remotePanel).toBeVisible({ timeout: 90_000 });
    await panelStatus(receiver.page, 'current');
    await expect(receiver.page.locator('#agreement-panel-title')).toHaveText(TITLE);
    await expect(remotePanel.locator('code.agreement-panel-cid')).toHaveAttribute('title', cid);
    await expect(remotePanel.locator('[data-agreement-remote-status="active"]')).toBeVisible({ timeout: 30_000 });
    await expect(remotePanel.locator('[data-agreement-action="edit"]')).toHaveCount(0);
    const imported = await storedAgreements(receiver.page);
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ title: TITLE, published: { cid }, designs: [{ proposalId: `design-${layoutCid}`, cid: layoutCid }] });
    expect(imported[0].outputs.map((output: any) => output.hash)).toEqual(saved.outputs.map((output: any) => output.hash));
    imported[0].outputs.forEach((output: any) => expect(output.geometry).toBeTruthy());
    expect(await receiver.page.evaluate(id => !!(window as any).isApplied((window as any).proposalStorage.getProposal(id)), `design-${layoutCid}`)).toBe(true);
    // The receiving device only read the index.
    expect(postsOf(index).filter(request => request.path !== '/designs/batch')).toHaveLength(2);
  } finally {
    await receiver.context.close();
  }
});

test('a proposed owners’ agreement shows the owners’ decisions card, reads its decisions from the relay and closes them once expired', async ({ mockApi: page }) => {
  test.setTimeout(240_000);
  const { layoutId } = await applyLayout(page);
  const index = pageIndex(page);

  // The owners decide by default, in a non-binding vote; the author ticks Binding to make it bind.
  const editor = await createFromPlan(page, layoutId);
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await expect(editor.locator('input[name="agreement-electorate"][value="owners"]')).toBeChecked();
  await expect(editor.locator('[data-agreement-binding]')).not.toBeChecked();
  await editor.locator('[data-agreement-binding]').check();
  await editor.locator('[data-agreement-title]').fill('Owners decide');
  await editorSave(editor).click();
  await editorClosed(page);
  const panel = await openStackAgreement(page);
  await panel.locator('[data-agreement-action="propose"]').click();
  await chooseProfileName(page, AUTHOR);
  await panel.locator('[data-agreement-action="propose"]').click();
  await expect(panel.locator('code.agreement-panel-cid')).toBeVisible({ timeout: 30_000 });

  const [cid] = [...index.agreements.keys()];
  expect(index.agreements.get(cid)!.content.rule).toMatchObject({ electorate: 'owners', binding: true });
  // The owners' card takes the community note's place, and the decisions on the CID are read.
  await expect(panel.locator('[data-agreement-community-note]')).toHaveCount(0);
  const card = panel.locator('[data-approval-card-slot] [data-approval-card]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator('.approval-card__title')).toHaveText('Owner decisions');
  await expect.poll(() => index.requests.some(request => request.method === 'GET' && request.path === `/agreements/${cid}/decisions`),
    { timeout: 30_000 }).toBe(true);
  expect(index.decisions.get(cid) || []).toEqual([]);
  // Nobody has decided yet; an owner is acted for through a lens member.
  await expect(card.locator('.approval-card__status--pending')).toHaveText('Configured approval rules not met');
  await expect(card.locator('[data-approval-action="verify"]')).toBeVisible();

  // Once the index reads the agreement as expired, it takes no more decisions.
  index.agreements.get(cid)!.status = 'expired';
  await closeAgreementPanel(page);
  const [{ id }] = await storedAgreements(page);
  const list = await openAgreementsList(page);
  await openListedAgreement(list, id);
  await expect(panel.locator('[data-agreement-remote-status="expired"]')).toHaveText('Expired', { timeout: 30_000 });
  await expect(card.locator('[data-approval-closed]')).toHaveText('This agreement no longer takes decisions.');
  await expect(card.locator('[data-approval-action="verify"]')).toHaveCount(0);
});

test('an agreement-link read that hangs gives up at the deadline, releases deep-link parcel suppression and says so', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  // A short parcel-load deadline, the limit an agreement link's read shares with a design link's.
  await page.addInitScript(() => { (window as any).PARCEL_LOAD_TIMEOUT_MS = 500; });
  const cid = cidOfObject({ schema: 'agreement/v1', title: 'An agreement whose index read hangs' });
  let held = 0;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname.endsWith(`/agreements/${cid}`), async route => {
    if (route.request().method() !== 'GET' || !['fetch', 'xhr'].includes(route.request().resourceType())) return route.fallback();
    held += 1;
    await gate;
    try {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Agreement not found', code: 'agreement-not-found' }) });
    } catch { /* The app's deadline may already have cancelled the intercepted request. */ }
  });
  try {
    await page.goto(`/agreements/${cid}?city=zg&reduceMotion=1`, { waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);
    await expect.poll(() => held).toBeGreaterThan(0);
    // The read is still held: only the deadline can have ended the route.
    await expect.poll(() => page.evaluate(() => (window as any).skipParcelFetchUntilProposalLoaded), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => page.evaluate(() => (window as any).statusLogEntries()
      .some((entry: any) => /could not be reached/i.test(entry.message)))).toBe(true);
    expect(await storedAgreements(page)).toEqual([]);
    await expect(agreementPanel(page)).toBeHidden();
  } finally {
    release();
  }
});
