// Exercise editable fields on supporting pages and assert their real query and rendering effects.
import { test, expect } from '../helpers/fixtures';
import { selectNativeOption } from '../helpers/controls';
import { cidOfObject } from '../helpers/mocks/shared-server';

const json = (route: any, body: unknown) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

test.describe('Supporting page form controls @core', () => {
  test('Lens directory and decision fields select a service, refuse a malformed CID and show the member\'s refusal', async ({ mockApi: page }) => {
    const southKey = 'So11111111111111111111111111111111111111112';
    const cid = cidOfObject({ schema: 'agreement/v1', title: 'Secondary form controls agreement' });
    const posted: Array<{ path: string; token: string | undefined }> = [];
    await page.route('**/lenses/members', route => json(route, { members: [
      { key: '11111111111111111111111111111111', name: 'North member', serviceUrl: 'https://north-lens.example', coverage: {} },
      { key: southKey, name: 'South member', serviceUrl: 'https://south-lens.example', coverage: {} },
    ] }));
    await page.route('**/lens/status', route => {
      const south = route.request().url().includes('south-lens.example');
      return json(route, { key: south ? southKey : '11111111111111111111111111111111', kind: 'permit', identity: 'verified', credential: 'fixture', counts: { ownership: 1 }, pricing: {} });
    });
    await page.route('**/lens/attestations*', route => json(route, { attestations: [] }));
    // The member counts the relayed owner decisions and refuses while the rule is not met, with the tally.
    await page.route('https://south-lens.example/lens/agreements/**', route => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      posted.push({ path: new URL(request.url()).pathname, token: request.headers()['x-lens-operator-token'] });
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
        error: 'rule_not_met', message: 'the decision rule is not met',
        tally: { passed: false, ready: true, reason: null, acceptedOwners: 1, totalOwners: 2, acceptedAreaM2: 400, totalAreaM2: 812.5 },
      }) });
    });
    await page.goto('/lens.html');
    await expect(page.locator('#lc-language')).toBeVisible();
    await expect(page.locator('#lc-service-title')).toHaveText('Member service');

    await selectNativeOption(page.locator('#lc-directory'), 'https://south-lens.example');
    await expect(page.locator('#lc-service-url')).toHaveValue('https://south-lens.example');
    await expect(page.locator('#lc-status')).toContainText('verified');

    // Not a CID: refused before anything is sent, and the token stays for the corrected try.
    const result = page.locator('#lc-decision-result');
    await page.locator('#lc-decision-cid').fill('not-an-agreement-cid');
    await page.locator('#lc-decision-token').fill('fixture-operator-token');
    await page.locator('#lc-decision-submit').click();
    await expect(result).toHaveAttribute('data-outcome', 'invalid');
    await expect(result).toHaveAttribute('data-code', 'cid');
    await expect(result).toContainText('Enter the CID of an agreement (bafkrei…).');
    await expect(page.locator('#lc-decision-token')).toHaveValue('fixture-operator-token');
    expect(posted).toEqual([]);

    // The member refuses: its code and the tally it judged on are shown, and the token is gone.
    await page.locator('#lc-decision-cid').fill(cid);
    await page.locator('#lc-decision-submit').click();
    await expect(result).toHaveAttribute('data-outcome', 'refused', { timeout: 15_000 });
    await expect(result).toHaveAttribute('data-code', 'rule_not_met');
    await expect(result).toContainText('The owner decisions relayed so far do not meet the agreement’s decision rule.');
    await expect(result).toContainText('not met');
    await expect(result).toContainText('1 of 2 accepted');
    await expect(page.locator('#lc-decision-token')).toHaveValue('');
    expect(posted).toEqual([{ path: `/lens/agreements/${cid}/decision`, token: 'fixture-operator-token' }]);

    await selectNativeOption(page.locator('#lc-language'), 'hr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'hr');
    await expect(page.locator('#lc-service-title')).toHaveText('Servis člana');
    await expect(page.locator('#lc-service-load')).toHaveText('Učitaj');
  });

  test('parcel coverage language and city/country fields change displayed research results', async ({ mockApi: page }) => {
    const city = (values: Record<string, unknown>) => ({
      id: values.id, name: values.name, country: values.country, countryCode: values.countryCode,
      appCityIds: values.appCityIds, cohorts: values.cohorts, researchFocusRegion: values.researchFocusRegion,
      growthRank: values.growthRank, checked: values.checked, registryFound: values.registryFound,
      verifiedSample: false, evidenceUrls: [], integrationAttempts: values.integrationAttempts || [],
      population2025: null, annualGrowthPct2015To2025: null, wupName: values.name,
      populationPlausibility2025: null, checkedDate: null, checkedDateEvidence: null,
      impliedParcelsTried: null, registryBasis: null, osmUrl: null, googleMapsUrl: null, wikipediaUrl: null,
    });
    const report = {
      metadata: {
        asOf: '2026-10-15', configuredAppCityCount: 1, checkedCityCount: 1, uncheckedCityCount: 1,
        cityRegistryFoundCount: 1, nationalCadastreCount: 1, statisticalJurisdictions: 2,
        populationMatchedCount: 0, growthMatchedCount: 0, checkedCitiesMissingDate: 0,
        wikiCityCount: 0, verifiedCitySampleCount: 0, countryTwoRegionCount: 0,
      },
      world: { landAreaKm2: 100, builtUpAreaKm2: 40, population: 1000 },
      breakdown: ['national', 'local', 'none', 'unknown'].map(id => ({
        id, label: id, jurisdictions: 1, landAreaKm2: 25, builtUpAreaKm2: 10,
        population: 250, landAreaKm2Pct: 25, builtUpAreaKm2Pct: 25, populationPct: 25,
      })),
      cities: [
        city({ id: 'city-supported', name: 'Zagreb', country: 'Croatia', countryCode: 'HR', appCityIds: ['zagreb'], cohorts: ['largest200'], checked: true, registryFound: true,
          integrationAttempts: [{ outcome: 'qualified', checkedAt: '2026-10-10T00:00:00Z', summary: 'Confirmed with the Zagreb fixture.', sources: [{ name: 'City registry' }], evidenceUrl: 'https://evidence.example/zagreb' }] }),
        city({ id: 'city-queued', name: 'Sample India City', country: 'India', countryCode: 'IN', appCityIds: [], cohorts: ['growth200'], researchFocusRegion: 'India', growthRank: 2, checked: false, registryFound: false }),
      ],
      countries: [
        { name: 'Croatia', code: 'HR', category: 'national', citiesChecked: 1, citiesWithRegistry: 1, nationalCadastreFound: true, statisticsIncluded: true, landAreaKm2: 25, evidenceUrls: [], probeStatus: 'national_online_cadastre_verified_sample' },
        { name: 'India', code: 'IN', category: 'none', citiesChecked: 1, citiesWithRegistry: 0, nationalCadastreFound: false, statisticsIncluded: true, landAreaKm2: 75, evidenceUrls: [], probeStatus: 'no_online_cadastre_found' },
      ],
      sources: [],
    };
    await page.route('**/data/parcel-coverage-report.json', route => json(route, report));
    await page.goto('/parcel-coverage-report.html');
    await expect(page.locator('#report-content')).toBeVisible();

    await selectNativeOption(page.locator('#report-language'), 'es');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.locator('#report-title')).not.toHaveText('Where can we find parcel registries?');

    const cityRows = page.locator('#city-table tbody tr');
    const assertOnlyCity = async (name: string) => {
      await expect(cityRows).toHaveCount(1);
      await expect(cityRows.first()).toContainText(name);
    };
    await page.locator('#city-search').fill('Zagreb');
    await assertOnlyCity('Zagreb');
    await page.locator('#city-search').fill('');

    await selectNativeOption(page.locator('#city-support'), 'yes');
    await assertOnlyCity('Zagreb');
    await expect(page).toHaveURL(/support=yes/);
    await selectNativeOption(page.locator('#city-support'), 'no');
    await assertOnlyCity('Sample India City');

    await selectNativeOption(page.locator('#city-support'), 'all');
    await selectNativeOption(page.locator('#city-checked'), 'yes');
    await assertOnlyCity('Zagreb');
    await selectNativeOption(page.locator('#city-checked'), 'no');
    await assertOnlyCity('Sample India City');

    await selectNativeOption(page.locator('#city-checked'), 'all');
    await selectNativeOption(page.locator('#city-registry'), 'yes');
    await assertOnlyCity('Zagreb');
    await selectNativeOption(page.locator('#city-registry'), 'no');
    await assertOnlyCity('Sample India City');

    await selectNativeOption(page.locator('#city-registry'), 'all');
    await selectNativeOption(page.locator('#city-cohort'), 'largest200');
    await assertOnlyCity('Zagreb');
    await selectNativeOption(page.locator('#city-cohort'), 'growth200');
    await assertOnlyCity('Sample India City');

    await selectNativeOption(page.locator('#city-cohort'), 'all');
    await selectNativeOption(page.locator('#city-country'), 'IN');
    await assertOnlyCity('Sample India City');
    await selectNativeOption(page.locator('#city-country'), 'HR');
    await assertOnlyCity('Zagreb');

    await page.locator('#country-search').fill('Croatia');
    await expect(page.locator('#country-table tbody tr')).toHaveCount(1);
    await expect(page.locator('#country-table tbody')).toContainText('Croatia');
    await expect(page.locator('#country-table tbody')).not.toContainText('India');
    await page.locator('#country-search').fill('');
    await selectNativeOption(page.locator('#country-category'), 'none');
    await expect(page.locator('#country-table tbody tr[data-record-id="IN"]')).toBeVisible();
    await expect(page.locator('#country-table tbody tr[data-record-id="HR"]')).toHaveCount(0);
    await selectNativeOption(page.locator('#country-category'), 'national');
    await expect(page.locator('#country-table tbody tr[data-record-id="HR"]')).toBeVisible();
    await expect(page.locator('#country-table tbody tr[data-record-id="IN"]')).toHaveCount(0);

    await page.locator('#city-search').fill('Zagreb');
    await page.locator('#city-table .city-integration-button').click();
    const integration = page.locator('#integration-dialog');
    await expect(integration).toBeVisible();
    await expect(integration).toContainText('Confirmed with the Zagreb fixture.');
    await page.locator('#integration-close').click();
    await expect(integration).toBeHidden();
  });

  test('transaction auto-refresh and limit controls change the real database read', async ({ mockApi: page }) => {
    test.setTimeout(60_000);
    await page.clock.install();
    const listRequests: string[] = [];
    const payload = {
      cluster: 'devnet', fetchedAt: '2026-10-15T12:00:00Z', cached: false,
      explorer: { tx: 'https://explorer.solana.com/tx/{sig}?cluster=devnet', address: 'https://explorer.solana.com/address/{addr}?cluster=devnet' },
      watched: [{ address: 'wallet-one', label: 'agent wallet', kind: 'wallet' }], count: 1,
      transactions: [{ signature: 'form-control-sig', time: '2026-10-15T12:00:00Z', status: 'success', summary: 'Control fixture transaction', feePayer: { address: 'wallet-one', label: 'agent wallet' }, feeSol: '0.00001', programs: ['demo'], actions: ['create'], amounts: [], instructions: [] }],
    };
    await page.route('**/transactions**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/transactions/watched')) return json(route, { watched: payload.watched, explorer: payload.explorer });
      if (url.pathname.endsWith('/transactions')) {
        listRequests.push(url.searchParams.get('limit') || '');
        return json(route, payload);
      }
      return route.continue();
    });

    await page.goto('/tx-explorer.html');
    await expect(page.locator('.tx-row[data-signature="form-control-sig"]')).toBeVisible();
    await expect.poll(() => listRequests.length).toBe(1);
    expect(listRequests).toEqual(['25']);

    await selectNativeOption(page.locator('#tx-limit'), '50');
    await expect.poll(() => listRequests.length).toBe(2);
    expect(listRequests).toEqual(['25', '50']);
    await expect(page.locator('#tx-limit')).toHaveValue('50');

    await page.locator('#tx-auto').check();
    await expect(page.locator('#tx-auto')).toBeChecked();
    await page.clock.fastForward(30_000);
    await expect.poll(() => listRequests.length).toBe(3);
    expect(listRequests).toEqual(['25', '50', '50']);
  });
});
