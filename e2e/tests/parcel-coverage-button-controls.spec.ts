// Exercise the coverage report's category filters and both directions of every table sort.
import { test, expect } from '../helpers/fixtures';

const bars = [
  { metric: 'Classified land area', categories: ['national', 'local', 'none', 'unknown'] },
  { metric: 'Built-up surface', categories: ['national', 'local', 'none', 'unknown'] },
  { metric: 'Population', categories: ['national', 'local', 'none', 'unknown'] },
];

type SortValue = { id: string; value: number | string | null };

async function displayedSortValues(page: any, tableId: string, column: number): Promise<SortValue[]> {
  return page.locator(`#${tableId} tbody tr`).evaluateAll((rows: HTMLTableRowElement[], index) => rows.map(row => {
    const cell = row.cells[index];
    const badge = cell.querySelector('.cb-badge');
    if (badge) {
      const label = badge.textContent?.trim();
      return { id: row.dataset.recordId || '', value: label === 'Yes' ? 1 : label === 'No' ? 0 : null };
    }
    const link = cell.querySelector('a');
    if (link) return { id: row.dataset.recordId || '', value: link.href || null };
    const button = cell.querySelector('button');
    if (button) return { id: row.dataset.recordId || '', value: button.textContent?.trim() || null };
    const strong = cell.querySelector('strong');
    if (strong) return { id: row.dataset.recordId || '', value: strong.textContent?.trim() || null };

    const text = cell.textContent?.trim() || '';
    if (!text || ['—', 'Unknown', 'Not recorded'].includes(text)) return { id: row.dataset.recordId || '', value: null };
    if (cell.classList.contains('number')) {
      const parsed = Number(text.replace(/[^\d.-]/g, ''));
      return { id: row.dataset.recordId || '', value: Number.isFinite(parsed) ? (parsed === 0 ? 0 : parsed) : null };
    }
    return { id: row.dataset.recordId || '', value: text };
  }), column);
}

function compareSortValues(left: SortValue['value'], right: SortValue['value']): number {
  if (left == null || right == null) return left == null ? (right == null ? 0 : 1) : -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return new Intl.Collator('en', { sensitivity: 'base', numeric: true }).compare(String(left), String(right));
}

function expectSortedBothWays(first: SortValue[], second: SortValue[], firstDirection: 'ascending' | 'descending'): void {
  const assertOrdered = (rows: SortValue[], direction: 'ascending' | 'descending') => {
    let missingSeen = false;
    let previous: SortValue['value'] = null;
    const violations: string[] = [];
    for (const row of rows) {
      if (row.value == null) { missingSeen = true; continue; }
      if (missingSeen) violations.push(`non-missing value ${String(row.value)} appears after a missing value`);
      if (previous != null) {
        const comparison = compareSortValues(previous, row.value);
        if (direction === 'ascending' ? comparison > 0 : comparison < 0) {
          violations.push(`values ${String(previous)} then ${String(row.value)} should sort ${direction}`);
        }
      }
      previous = row.value;
    }
    expect(violations).toEqual([]);
  };
  assertOrdered(first, firstDirection);
  const reverseDirection = firstDirection === 'ascending' ? 'descending' : 'ascending';
  assertOrdered(second, reverseDirection);

  const tieGroups = (rows: SortValue[]) => rows.reduce<Array<{ value: SortValue['value']; ids: string[] }>>((groups, row) => {
    const current = groups[groups.length - 1];
    if (current && compareSortValues(current.value, row.value) === 0) current.ids.push(row.id);
    else groups.push({ value: row.value, ids: [row.id] });
    return groups;
  }, []);
  const firstGroups = tieGroups(first);
  const secondGroups = tieGroups(second);
  const present = (groups: ReturnType<typeof tieGroups>) => groups.filter(group => group.value != null);
  const missing = (groups: ReturnType<typeof tieGroups>) => groups.filter(group => group.value == null);
  expect(present(secondGroups).map(group => group.value)).toEqual(present(firstGroups).map(group => group.value).reverse());
  // Displayed numbers are rounded: e.g. -0.02 and 0.02 both display as zero, but their
  // underlying sort keys legitimately reverse. Preserve the rows within each displayed group;
  // exact text ties and missing values must also retain their source order.
  const groupIds = (group: { value: SortValue['value']; ids: string[] }) =>
    typeof group.value === 'number' ? group.ids.slice().sort() : group.ids;
  expect(present(secondGroups).map(groupIds)).toEqual(present(firstGroups).map(groupIds).reverse());
  expect(missing(secondGroups).map(group => group.ids)).toEqual(missing(firstGroups).map(group => group.ids));
}

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

        const firstOrder = await displayedSortValues(page, tableId, index);
        const reverse = expectedAfter === 'ascending' ? 'descending' : 'ascending';
        await page.locator(`#${tableId} thead th`).nth(index).getByRole('button').click();
        await expect(page.locator(`#${tableId} thead th`).nth(index)).toHaveAttribute('aria-sort', reverse);
        const secondOrder = await displayedSortValues(page, tableId, index);
        // The values reverse by sort key; equal-key rows and missing rows keep their source order.
        expectSortedBothWays(firstOrder, secondOrder, expectedAfter);
      }
  });
});
