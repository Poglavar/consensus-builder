// Purpose: publishing one design from the screen (plan-design-agreement.md, M2 "Browser"): Share on an
// applied design's details pins its design/v1 object through POST /pins and indexes it with POST
// /designs under the CID the browser computed, the details then say Published with that CID, the
// copied /designs/<cid> link imports and applies the design on another device, and a second Share
// sends nothing again.
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal, proposalState, chooseProfileName, stubBasemapTiles, openOnAnotherDevice } from '../helpers/runtime';
import { canonicalJson, cidOfBytes, cidOfObject, pageIndex, SharedIndex } from '../helpers/mocks/shared-server';

test.beforeEach(async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
});

// The fields of a design/v1 object besides its one payload (frontend/js/design-record.js FIELDS).
const DESIGN_FIELDS = ['schema', 'goal', 'title', 'description', 'author', 'city', 'site', 'toleranceM', 'geometry', 'origin', 'authoredAt'];

const postsOf = (index: SharedIndex) => index.requests.filter(request => request.method === 'POST');

test('Share on an applied park publishes its design object under the CID the browser computed, and its link applies it on another device @core', async ({ mockApi: page, browser, baseURL }) => {
  test.setTimeout(240_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  const proposalId = await createSpace(page, 'park');
  const index = pageIndex(page);

  await showProposal(page, proposalId);
  const details = page.locator('#proposal-details-panel');
  await expect(details.locator('.cb-badge--draft')).toBeVisible();
  // A guest chooses a profile name first: the design carries its author, and nothing left the device.
  await details.locator('.btn-share-proposal').click();
  await chooseProfileName(page, 'Share author');
  expect(postsOf(index)).toEqual([]);

  await showProposal(page, proposalId);
  await details.locator('.btn-share-proposal').click();
  await expect(details.locator('.cb-badge--published')).toBeVisible({ timeout: 30_000 });

  // The courier got the canonical bytes, the index the object they encode, both under one CID that
  // is the CID of those bytes (recomputed here with node's crypto) and the one the browser computes.
  const posts = postsOf(index);
  expect(posts.map(request => request.path)).toEqual(['/pins', '/designs']);
  const [pin, indexed] = posts;
  expect(pin.body.kind).toBe('design');
  const bytes = Buffer.from(pin.body.bytes, 'base64');
  const cid = pin.body.cid;
  expect(cid).toMatch(/^bafkrei[a-z2-7]{52}$/);
  expect(cidOfBytes(bytes)).toBe(cid);
  expect(indexed.body.cid).toBe(cid);
  expect(bytes.toString('utf8')).toBe(canonicalJson(indexed.body.content));
  expect(cidOfObject(indexed.body.content)).toBe(cid);
  expect(await page.evaluate(id => {
    const w = window as any;
    return w.Cid.cidOfObject(w.DesignRecord.published(w.proposalStorage.getProposal(id)));
  }, proposalId)).toBe(cid);

  // The design/v1 object is the drawing and its authorship: no parcels, terms, kind or local state.
  const content = indexed.body.content;
  expect(Object.keys(content).sort()).toEqual([...DESIGN_FIELDS, 'structureProposal'].sort());
  expect(content).toMatchObject({ schema: 'design/v1', goal: 'park', author: 'Share author', city: 'zagreb', origin: null });
  expect(content.structureProposal).toMatchObject({ kind: 'park' });
  expect(content.structureProposal).not.toHaveProperty('decorations');
  expect(content.structureProposal).not.toHaveProperty('applied');

  // The details say Published, with that CID; the record is marked; the link is on the clipboard.
  await expect(details.locator(`[data-proposal-published-cid="${cid}"]`)).toBeAttached();
  const sender = await proposalState(page, proposalId);
  expect(sender.published).toMatchObject({ cid });
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(`${new URL(page.url()).origin}/designs/${cid}?city=zg&3d&lang=en`);

  // Sharing it again copies the same link and sends nothing: it still hashes to its published CID.
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await details.locator('.btn-share-proposal').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  expect(postsOf(index)).toHaveLength(2);

  // Another device opens the link (in 2D here): the design is read from the index by CID, stored as
  // design-<cid>, applied and opened.
  const receiver = await openOnAnotherDevice(browser, `/designs/${cid}?city=zg&reduceMotion=1`, index, baseURL);
  try {
    const localId = `design-${cid}`;
    await expect.poll(() => receiver.page.evaluate(id => {
      const w = window as any;
      const record = w.proposalStorage?.getProposal(id);
      return !!record && !!w.isApplied(record);
    }, localId), { timeout: 90_000 }).toBe(true);
    expect(index.requests.some(request => request.method === 'POST' && request.path === '/designs/batch')).toBe(true);
    const imported = await receiver.page.evaluate(id => {
      const w = window as any;
      const record = w.proposalStorage.getProposal(id);
      return { published: record.published, cid: w.DesignSync.publishedCid(record), author: record.author, goal: record.goal, count: w.proposalStorage.getAllProposals().length };
    }, localId);
    expect(imported).toMatchObject({ cid, author: 'Share author', goal: 'park', count: 1, published: { cid } });
    // The shared-design route opens the current design details inside the click stack.
    const receiverDetails = receiver.page.locator('#proposal-details-panel');
    await expect(receiverDetails).toBeVisible({ timeout: 30_000 });
    await expect(receiverDetails.locator(`[data-proposal-published-cid="${cid}"]`)).toBeAttached({ timeout: 30_000 });
    await expect(receiverDetails.locator('.cb-badge--published')).toBeVisible();
    // The receiving device sent nothing to the courier or the index.
    expect(postsOf(index).filter(request => request.path !== '/designs/batch')).toHaveLength(2);
  } finally {
    await receiver.context.close();
  }
});
