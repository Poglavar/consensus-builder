// NGO consultation journeys: metadata at creation, external participation, real message signatures,
// append-only result history and live withdrawal of a website's reporting-wallet authorization.
import { generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { applyLayout, agreementEditor, editorSave, editorClosed, storedAgreements, openAgreementsList, proposeOverPark } from '../helpers/agreements';
import { fileAgreement, pageIndex, cidOfObject } from '../helpers/mocks/shared-server';
import { injectMockSolanaWallet } from '../helpers/blockchain';

const requireBackend = createRequire(path.resolve(__dirname, '../../backend/package.json'));
const lens = requireBackend('../frontend/js/lens-core.js');
const result = requireBackend('../frontend/js/community/result.js');
const consultation = requireBackend('../frontend/js/community/consultation.js');
const ORGANISER = 'did:web:ngo.example:ugt';

test('Ask the community opens consultation fields and saves metadata without settlement terms @core', async ({ mockApi: page }) => {
  test.setTimeout(180_000);
  await stubBasemapTiles(page);
  await applyLayout(page);
  await openAgreementsList(page);
  await page.locator('.agreement-list-dialog [data-agreement-action="community"]').click();
  const editor = agreementEditor(page);
  await expect(editor).toBeVisible();
  await expect(editor.locator('[data-agreement-electorate][value="community"]')).toBeChecked();
  await expect(editor.locator('[data-agreement-allocation]').first()).toBeHidden();
  await expect(editor.locator('[data-agreement-cash]').first()).toBeHidden();
  await editor.locator('[data-agreement-title]').fill('Neighbourhood park consultation');
  await editor.locator('[data-agreement-organiser]').fill('https://ngo.example/ugt');
  await editor.locator('[data-agreement-participation-url]').fill('https://ngo.example/park-vote');
  await editorSave(editor).click();
  await editorClosed(page);
  const [record] = await storedAgreements(page);
  expect(record.consultation).toEqual({ organiser: ORGANISER, participationUrl: 'https://ngo.example/park-vote' });
  expect(record.rule).toMatchObject({ electorate: 'community', binding: false, approvalConfig: null, lens: [] });
  expect(record.allocations).toEqual([]);
  expect(record.money.lines).toEqual([]);
  await expect(page.locator('#agreement-panel [data-community-participate]')).toHaveAttribute('href', 'https://ngo.example/park-vote');
  await expect(page.locator('#agreement-panel')).toContainText('gives no owner consent');
});

test('a shared consultation signs results, keeps history and rechecks website authorization @core', async ({ mockApi: page }) => {
  test.setTimeout(180_000);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = lens.base58Encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  let signatures = 0;
  await injectMockSolanaWallet(page, { publicKey: address });
  await page.exposeFunction('signCommunityTestMessage', (bytes: number[]) => {
    signatures++;
    return [...sign(null, Buffer.from(bytes), privateKey)];
  });
  await page.addInitScript(() => {
    (window as any).solana.signMessage = async (bytes: Uint8Array) => new Uint8Array(await (window as any).signCommunityTestMessage([...bytes]));
  });
  await stubBasemapTiles(page);
  await openCity(page);
  const initial = await proposeOverPark(page, { title: 'Park consultation' });
  const index = pageIndex(page);
  const content = { ...index.agreements.get(initial.cid)!.content, deadline: '2020-01-01T00:00:00.000Z', consultation: { organiser: ORGANISER, participationUrl: 'https://ngo.example/vote' } };
  const cid = fileAgreement(index, content);
  let document = consultation.setupDocument(ORGANISER, { address }, 'devnet');
  await page.route('https://ngo.example/ugt/did.json', route => route.fulfill({
    contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(document)
  }));
  await page.context().route(/https:\/\/ngo\.example\/(vote|results)$/, route => route.fulfill({
    contentType: 'text/html', body: '<main><h1>Organiser consultation page</h1></main>'
  }));
  const reports: any[] = [];
  let posts = 0;
  await page.route(`**/agreements/${cid}/community-reports`, async route => {
    if (route.request().method() === 'POST') {
      posts++;
      const body = route.request().postDataJSON();
      expect(body.cid).toBe(cidOfObject(body.content));
      expect(await result.verifyReport(body.content, { agreementCid: cid, organiser: ORGANISER })).toEqual({ ok: true });
      const duplicate = reports.some(row => row.cid === body.cid);
      if (!duplicate) reports.push(body);
      return route.fulfill({ status: duplicate ? 200 : 201, contentType: 'application/json', body: JSON.stringify({ stored: true, duplicate, cid: body.cid }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ agreementCid: cid, reports }) });
  });
  await page.context().route('https://ipfs.io/ipfs/*', route => {
    const row = reports.find(item => route.request().url().endsWith(item.cid));
    return row ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(row.content) }) : route.fallback();
  });
  await page.goto(`/agreements/${cid}?city=zg`);
  const panel = page.locator('#agreement-panel');
  await expect(panel).toBeVisible({ timeout: 45_000 });
  await expect(panel.locator('[data-community-participate]')).toHaveAttribute('href', 'https://ngo.example/vote');
  await expect(panel).toContainText('No result has been reported yet.');
  const [participation] = await Promise.all([page.waitForEvent('popup'), panel.locator('[data-community-participate]').click()]);
  await expect(participation.getByRole('heading', { name: 'Organiser consultation page' })).toBeVisible();
  expect(participation.url()).toBe('https://ngo.example/vote');
  await participation.close();

  await page.evaluate(async () => { await (window as any).solanaWalletManager.disconnect(); });
  await panel.locator('.community-setup summary').click();
  await panel.locator('[data-community-action="connect"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).solanaWalletManager.getState().status)).toBe('connected');
  await expect(panel.locator('.community-setup pre')).toContainText(address);
  await panel.locator('[data-community-action="compose"]').click();
  await panel.locator('[data-community-statement]').fill('An unfinished draft.');
  await panel.locator('[data-community-action="cancel"]').click();
  await expect(panel.locator('[data-community-form]')).toHaveCount(0);
  expect(posts).toBe(0);
  await panel.locator('[data-community-action="compose"]').click();
  await panel.locator('[data-community-statement]').fill('Residents support the park.');
  await panel.locator('[data-community-url]').fill('https://ngo.example/results');
  await panel.locator('[data-community-form] button[type="submit"]').click();
  await expect(panel).toContainText('Signed report published and read back.', { timeout: 45_000 });
  await expect(panel.locator('[data-community-website="listed"]')).toHaveCount(1);
  expect(signatures).toBe(1);
  expect(posts).toBe(1);
  expect(index.agreements.get(cid)!.content).toEqual(content);
  const [details] = await Promise.all([page.waitForEvent('popup'), panel.getByRole('link', { name: 'Read the organiser’s report' }).click()]);
  await expect(details.getByRole('heading', { name: 'Organiser consultation page' })).toBeVisible();
  expect(details.url()).toBe('https://ngo.example/results');
  await details.close();
  const [signedRecord] = await Promise.all([page.waitForEvent('popup'), panel.getByRole('link', { name: 'Signed record', exact: true }).click()]);
  await expect(signedRecord.locator('body')).toContainText(reports[0].content.proof.signature);
  await signedRecord.close();

  await panel.locator('[data-community-action="compose"]').click();
  await panel.locator('[data-community-statement]').fill('The final consultation report is available.');
  await panel.locator('[data-community-form] button[type="submit"]').click();
  await expect(panel).toContainText('Signed report published and read back.', { timeout: 45_000 });
  await expect(panel.locator('.community-history summary')).toHaveText('Previous reports (1)');
  expect(reports).toHaveLength(2);

  // Authorization is a live observation, rather than a cached endorsement of a historic snapshot.
  document = { ...document, assertionMethod: [] };
  await panel.locator('[data-community-action="refresh"]').click();
  await expect(panel.locator('[data-community-website="listed"]')).toHaveCount(0);
  await expect(panel.locator('[data-community-website="unlisted"]').first()).toHaveText('Wallet not listed by website');
  await panel.locator('[data-community-action="compose"]').click();
  await panel.locator('[data-community-statement]').fill('This must not be signed.');
  await panel.locator('[data-community-form] button[type="submit"]').click();
  await expect(panel).toContainText('does not list this wallet on this network', { timeout: 45_000 });
  expect(signatures).toBe(2);
  expect(posts).toBe(2);
  expect(reports).toHaveLength(2);
});
