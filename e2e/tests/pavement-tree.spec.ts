// The square editor's Pavement tree tool and the selected tree's card: plant a tree in a pit, make
// it taller, change its pit, and the saved square carries the tree record the 2D map draws and the
// model view opens over it.
import { test, expect } from '../helpers/fixtures';
import { openCity, clickMapPoint, createSpace, showProposal } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';

test('plants a pavement tree on a square and edits its height and pit from the tree card', async ({ mockApi: page }) => {
  await openCity(page);
  const proposalId = await createSpace(page, 'square');
  await showProposal(page, proposalId);
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  const editor = page.locator('#structure-geometry-editor');
  await expect(editor.locator('.on-map-editor__panel')).toBeVisible();

  await editor.locator('[data-tool="pavementTree"]').click();
  await clickMapPoint(page, 15.98208, 45.80018);
  const card = editor.locator('[data-role="tree-card"]');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-tree-pit="grille"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.structure-geometry-icon.is-tree.is-selected .park-tree-glyph.is-pit-grille')).toHaveCount(1);

  const summary = card.locator('[data-role="tree-summary"]');
  const height = async () => Number((await summary.textContent())?.match(/([\d.]+) m/)?.[1]);
  const before = await height();
  const taller = card.locator('[data-action="tree-taller"]');
  if (await taller.isEnabled()) {
    await taller.click();
    await expect.poll(height).toBe(Math.round((before + 1) * 10) / 10);
  } else {
    await card.locator('[data-action="tree-shorter"]').click();
    await expect.poll(height).toBe(Math.round((before - 1) * 10) / 10);
  }
  const edited = await height();
  await card.locator('[data-tree-pit="grass"]').click();
  await expect(card.locator('[data-tree-pit="grass"]')).toHaveAttribute('aria-pressed', 'true');

  await editor.locator('[data-action="save"]').click();
  await expect(editor).toHaveCount(0);
  const trees = await page.evaluate(id => (window as any).getProposalByIdOrHash(id).structureProposal.decorationDesign.trees, proposalId);
  expect(trees).toContainEqual(expect.objectContaining({ pit: 'grass', heightM: edited }));
  await expect(page.locator('.park-tree-glyph.is-pit-grass')).toHaveCount(1);

  // The model view draws the square with its pits; any error loading or building it fails the test.
  await mockBuildingScene(page);
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('body')).toHaveClass(/three-mode-active/);
});
