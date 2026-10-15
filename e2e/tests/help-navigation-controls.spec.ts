// Verify guide navigation links reach their real destinations and anchored sections.
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.use({ seedCity: 'zagreb' });

const helpPages = [
  'how-to-use.html',
  'how-to-use-buildings.html',
  'how-to-use-park-square.html',
  'how-to-use-reparcellization.html',
  'how-to-use-road.html',
  'how-to-use-views.html',
  'kako-koristiti.html',
  'kako-koristiti-cesta.html',
  'kako-koristiti-park-trg.html',
  'kako-koristiti-prikazi.html',
  'kako-koristiti-reparcelacija.html',
  'kako-koristiti-zgrade.html',
  'roadmap.html',
  'urban-planning.html',
];

test.describe('Help and planning page navigation controls @core', () => {
  for (const source of helpPages) {
    test(`${source} styled links navigate to their destination`, async ({ mockApi: page }) => {
      test.setTimeout(120_000);

      const sourceUrl = `/${source}`;
      await page.goto(sourceUrl);
      const buttons = page.locator('a.btn');
      const count = await buttons.count();
      expect(count, `${source} should contain styled navigation links`).toBeGreaterThan(0);

      for (let index = 0; index < count; index += 1) {
        if (index > 0) await page.goto(sourceUrl);

        const link = page.locator('a.btn').nth(index);
        const href = await link.getAttribute('href');
        expect(href, `${source} link ${index + 1} should have a destination`).toBeTruthy();
        const destination = new URL(href!, page.url());
        await link.click();
        await expect(page).toHaveURL(destination.href);

        if (destination.hash) {
          const sectionId = decodeURIComponent(destination.hash.slice(1));
          const section = page.locator(`[id="${sectionId}"]`);
          await expect(section).toBeVisible();
          await expect(section.locator('h2, h3').first()).toBeVisible();
        } else if (destination.pathname === '/' || destination.pathname.endsWith('/index.html')) {
          await waitForMapReady(page);
          await expect(page.locator('#map')).toBeVisible();
        } else {
          const heading = page.locator('h1').first();
          await expect(heading).toBeVisible();
          await expect(heading).not.toBeEmpty();
        }
      }
    });
  }
});
