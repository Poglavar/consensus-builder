// Exercise the coverage report's category filters and both directions of every table sort.
import { test, expect } from '../helpers/fixtures';

const bars = [
  { metric: 'Classified land area', categories: ['national', 'local', 'none', 'unknown'] },
  { metric: 'Built-up surface', categories: ['national', 'local', 'none', 'unknown'] },
  { metric: 'Population', categories: ['national', 'local', 'none', 'unknown'] },
];

test.describe('parcel coverage report controls @core', () => {
  test('every evidence segment filters the country inventory to its category', async ({ mockApi: page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/parcel-coverage-report.html');
    const report = page.locator('#report-content');
    await expect(report).toBeVisible();

    for (const { metric, categories } of bars) {
      for (const category of categories) {
        const segment = page.locator(`.metric-chart:has(h3:text-is("${metric}")) .bar-segment.${category}`);
        await expect(segment).toBeVisible();
        await expect(segment).toHaveAttribute('aria-label', new RegExp(`^${metric} ·`));
        await segment.click();
        await expect(page.locator('#country-category')).toHaveValue(category);
        await expect(page.locator('#country-table tbody tr')).not.toHaveCount(0);
      }
    }
  });

  for (const tableId of ['city-table', 'country-table', 'breakdown-table']) test(`${tableId} headings sort the displayed records in both directions`, async ({ mockApi: page }) => {
    await page.goto('/parcel-coverage-report.html');
    await expect(page.locator('#report-content')).toBeVisible();

      const headings = page.locator(`#${tableId} thead th`);
      const count = await headings.count();
      expect(count).toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        const heading = headings.nth(index);
        const before = await heading.getAttribute('aria-sort');
        const expectedAfter = before === 'ascending' ? 'descending' : 'ascending';
        await heading.getByRole('button').click();
        await expect(heading).toHaveAttribute('aria-sort', expectedAfter);

        const firstOrder = await page.locator(`#${tableId} tbody tr`).evaluateAll((rows, column) => rows.map(row => {
          const cell = row.children[column];
          return cell.querySelector('.status')?.textContent || cell.querySelector('a')?.getAttribute('href') || cell.querySelector('strong, button')?.textContent || cell.textContent;
        }), index);
        const reverse = expectedAfter === 'ascending' ? 'descending' : 'ascending';
        await page.locator(`#${tableId} thead th`).nth(index).getByRole('button').click();
        await expect(page.locator(`#${tableId} thead th`).nth(index)).toHaveAttribute('aria-sort', reverse);
        const secondOrder = await page.locator(`#${tableId} tbody tr`).evaluateAll((rows, column) => rows.map(row => {
          const cell = row.children[column];
          return cell.querySelector('.status')?.textContent || cell.querySelector('a')?.getAttribute('href') || cell.querySelector('strong, button')?.textContent || cell.textContent;
        }), index);
        // Missing values stay last in both directions; ties retain their source order.
        const groups = (values: Array<string | null>) => values.map(value => value?.trim()).filter(value => value && !['—', 'Unknown', 'Not recorded'].includes(value)).filter((value, at, list) => at === 0 || value !== list[at - 1]);
        expect(groups(secondOrder)).toEqual(groups(firstOrder).reverse());
      }
  });
});
