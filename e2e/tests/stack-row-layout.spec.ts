import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, stackSection, PARCEL_ID } from '../helpers/runtime';

for (const width of [1280, 390]) {
  test(`source parcel label, equal design actions and inline History at ${width}px`, async ({ mockApi: page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 }); await openCity(page); const id = await createSpace(page, 'park');
    await page.evaluate(id => (window as any).ClickStack.showDesign(id), id);
    const design = stackSection(page, 'designs');
    await expect(design.locator('.proposal-overview-facts')).toContainText('Source parcels:');
    await expect(design.locator('.proposal-overview-facts')).not.toContainText('Parcels in design:');
    const actions = design.locator('.proposal-primary-actions');
    // Add to plan heads the design card, so the hosted panel's actions do not repeat it (7cc412330):
    // Unapply, Share, Duplicate, Edit geometry and Before / after, two equal columns.
    await expect(design.locator('.click-stack__actions--design .btn-add-to-plan')).toBeVisible();
    const buttons = actions.locator('button:visible'); await expect(buttons).toHaveCount(5);
    const boxes = await buttons.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().toJSON()));
    const row = (await actions.boundingBox())!;
    for (let i = 0; i < boxes.length; i += 2) {
      expect(boxes[i].width).toBeCloseTo(boxes[0].width, 0); expect(boxes[i].x).toBeCloseTo(row.x, 0);
      if (i + 1 === boxes.length) break;
      expect(boxes[i].width).toBeCloseTo(boxes[i + 1].width, 0); expect(boxes[i].y).toBeCloseTo(boxes[i + 1].y, 0);
      expect(boxes[i + 1].right).toBeCloseTo(row.x + row.width, 0);
    }
    await page.evaluate(id => {
      const w = window as any; return w.ClickStack.showParcel(w.CadastralParcelRepository.get(id));
    }, PARCEL_ID);
    const parcel = stackSection(page, 'parcels'); await parcel.getByRole('tab', { name: 'Info', exact: true }).click();
    const history = parcel.locator('.parcel-history-section > summary').first(); await expect(history).toBeVisible();
    const geometry = await history.evaluate(summary => {
      const icon = summary.querySelector('i')!.getBoundingClientRect(), label = summary.querySelector('span')!.getBoundingClientRect();
      return { iconRight: icon.right, labelLeft: label.left, iconY: icon.y + icon.height / 2, labelY: label.y + label.height / 2 };
    });
    expect(geometry.iconRight).toBeLessThan(geometry.labelLeft); expect(geometry.iconY).toBeCloseTo(geometry.labelY, 0);
    await page.screenshot({ path: testInfo.outputPath('parcel-history-inline.png') });
  });
}
