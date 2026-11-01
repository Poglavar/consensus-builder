// Balconies and a slanted roof on an urban rule (UrbanRuleVariation extras): the Block editor's
// Balconies and Slanted roof checkboxes are saved on the design's rule, come back when it is edited,
// and the model view draws the roof, attic and balconies in addition to the building's massing. The
// Use select beside them sets the rule's use: a Block starts automatic.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, openBlockEditor, showProposal } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { Page } from '@playwright/test';

// Every urbanRule the design's buildings carry.
async function savedRules(page: Page, id: string) {
  return page.evaluate(id => {
    const rules: any[] = [];
    const walk = (value: any) => {
      if (!value || typeof value !== 'object') return;
      if (value.urbanRule && typeof value.urbanRule === 'object') rules.push(value.urbanRule);
      Object.values(value).forEach(walk);
    };
    walk(JSON.parse(JSON.stringify((window as any).getProposalByIdOrHash(id))));
    return rules;
  }, id);
}

const appliedBuildingId = (page: Page) => page.evaluate(() => {
  const w = window as any;
  return w.proposalStorage.getAllProposals().find((p: any) => p.geometry?.buildings?.length && w.isProposalApplied(p))?.proposalId ?? null;
});

// Meshes the model view draws for the design.
async function modelMeshes(page: Page, id: string) {
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  const count = () => page.evaluate(id => {
    let meshes = 0;
    (window as any).getThreeModeInternals?.()?.scene.traverse((object: any) => { if (object.isMesh && object.userData?.proposalId === String(id)) meshes++; });
    return meshes;
  }, id);
  await expect.poll(count, { timeout: 20_000 }).toBeGreaterThan(0);
  // Let the scene settle: the same count on two reads in a row.
  let last = -1;
  await expect.poll(async () => { const now = await count(); const same = now === last; last = now; return same; }, { timeout: 20_000, intervals: [500] }).toBe(true);
  await page.locator('#mode-2d-toggle').click();
  await expect(page.locator('#three-container')).toBeHidden();
  return last;
}

test('Balconies and a slanted roof are saved on the rule, restored on edit, and drawn in the model view', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  await openParcel(page, 'design');
  await openBlockEditor(page);

  const balconies = page.locator('#blockify-balconies');
  const depth = page.locator('#blockify-balcony-depth');
  const roof = page.locator('#blockify-slanted-roof');
  const use = page.locator('#blockify-use');
  await expect(use).toHaveValue('');
  await expect(use.locator('option[value=""]')).toHaveText(/Automatic/);
  await use.selectOption('office');
  await expect(balconies).toBeVisible();
  await expect(balconies).not.toBeChecked();
  await expect(depth).toBeHidden();
  await balconies.check();
  await expect(depth).toBeVisible();
  await expect(depth).toHaveValue('2');
  await depth.fill('1.5');
  await depth.press('Tab');
  await roof.check();

  await page.locator('#btn-blockify-done').click();
  await expect.poll(() => appliedBuildingId(page)).not.toBeNull();
  const id = String(await appliedBuildingId(page));
  const rules = await savedRules(page, id);
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules) expect(rule).toMatchObject({ balconyDepthM: 1.5, roof: 'pitched', use: 'office' });
  const withExtras = await modelMeshes(page, id);

  // Editing the design brings the choices back; turning both off saves a rule without them.
  await page.keyboard.press('Escape');
  await showProposal(page, id);
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  await expect(balconies).toBeVisible();
  await expect(balconies).toBeChecked();
  await expect(depth).toHaveValue('1.5');
  await expect(roof).toBeChecked();
  await expect(use).toHaveValue('office');
  await use.selectOption('');
  await balconies.uncheck();
  await expect(depth).toBeHidden();
  await roof.uncheck();
  await page.locator('#btn-blockify-done').click();
  await expect.poll(async () => {
    const current = await appliedBuildingId(page);
    if (!current) return 'none';
    const plain = await savedRules(page, String(current));
    return plain.length > 0 && plain.every(rule => !('balconyDepthM' in rule) && !('roof' in rule) && !('use' in rule)) ? 'plain' : 'extras';
  }).toBe('plain');
  const plainId = String(await appliedBuildingId(page));

  // The roof, attic windows and balconies are meshes of their own on top of the massing.
  const plainMeshes = await modelMeshes(page, plainId);
  expect(withExtras).toBeGreaterThan(plainMeshes);
});

test('A Detached rule starts as housing, its Use is saved on the rule, and it has no automatic choice', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--parcelBased').click();
  await expect(page.locator('#btn-parcelbased-done')).toBeEnabled({ timeout: 20_000 });
  const use = page.locator('#parcelbased-use');
  await expect(use).toHaveValue('residential');
  await expect(use.locator('option[value=""]')).toHaveCount(0);
  await use.selectOption('public');
  await page.locator('#btn-parcelbased-done').click();
  await expect.poll(() => appliedBuildingId(page)).not.toBeNull();
  const rules = await savedRules(page, String(await appliedBuildingId(page)));
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules) expect(rule).toMatchObject({ typology: 'parcelBased', use: 'public' });
});
