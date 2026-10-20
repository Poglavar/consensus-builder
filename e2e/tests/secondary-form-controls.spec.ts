// Exercise editable fields on supporting pages and assert their real query and rendering effects.
import { test, expect } from '../helpers/fixtures';
import { fillNativeDateTime, selectNativeOption } from '../helpers/controls';

const json = (route: any, body: unknown) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

test.describe('Supporting page form controls @core', () => {
  test('Canton buyer, owner, and lens fields are submitted in the created proposal', async ({ mockApi: page }) => {
    const created: any[] = [];
    const contract = {
      proposalContractId: 'form-contract-1', parcelId: 'PARCEL-NYC-2',
      buyer: 'Buyer::form-test', owner: 'Owner::form-test', lens: 'Lens::form-test',
    };
    await page.route('**/*', async route => {
      const request = route.request();
      if (request.resourceType() !== 'fetch' && request.resourceType() !== 'xhr') return route.continue();
      const url = new URL(request.url());
      if (url.pathname.includes('/parcel-nyc')) return json(route, {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { parcelId: 'PARCEL-NYC-1', estimatedMarketPrice: 125000 }, geometry: { type: 'Polygon', coordinates: [] } },
          { type: 'Feature', properties: { parcelId: 'PARCEL-NYC-2', estimatedMarketPrice: 275000 }, geometry: { type: 'Polygon', coordinates: [] } },
        ],
      });
      if (url.pathname.endsWith('/canton/proposals') && request.method() === 'POST') {
        created.push(request.postDataJSON());
        return json(route, contract);
      }
      if (url.pathname.endsWith('/canton/proposals') && request.method() === 'GET') return json(route, { proposals: [] });
      if (url.pathname.endsWith('/canton/sales')) return json(route, { sales: [] });
      return route.continue();
    });

    await page.goto('/canton.html');
    await expect(page.locator('#create-parcel')).toHaveValue('PARCEL-NYC-1');
    await selectNativeOption(page.locator('#create-parcel'), 'PARCEL-NYC-2');
    await expect(page.locator('#create-price')).toHaveValue('275000.00');
    await page.locator('#create-buyer').fill('Buyer::form-test');
    await page.locator('#create-owner').fill('Owner::form-test');
    await page.locator('#create-lens').fill('Lens::form-test');
    await page.locator('#create-price').fill('125000');
    await page.locator('#create-btn').click();

    await expect(page.locator('#create-result')).toContainText('Created form-contract-1');
    expect(created).toEqual([{
      parcelId: 'PARCEL-NYC-2', price: '125000', buyer: 'Buyer::form-test',
      owner: 'Owner::form-test', lens: 'Lens::form-test',
    }]);
    await expect(page.locator('#canton-party')).toHaveValue('Owner::form-test');
    await expect(page.locator('.canton-party-id[title="Buyer::form-test"]')).toBeVisible();
    await expect(page.locator('.canton-party-id[title="Lens::form-test"]')).toBeVisible();
  });

  test('floor-plan archive building, unit, site, and agency controls select their actual records', async ({ mockApi: page }) => {
    const sources = [
      { sha256: 'archive-source-alpha', label: 'Central archive drawing', sourceUrl: 'https://plans.example/central.pdf', status: 'reviewed' },
      { sha256: 'archive-source-beta', label: 'Western cadastral sheet', sourceUrl: 'https://plans.example/western.pdf', status: 'needs_review' },
    ];
    const agencies = [
      { legal_name: 'Northern Registry Office', registered_address: 'North District', website: 'https://north.example' },
      { legal_name: 'Southern Survey Agency', registered_address: 'South District', website: 'https://south.example' },
    ];
    await page.route('**/api/floor-plans?*', route => json(route, {
      plans: [
        { id: 'north-floor-1', scope: 'floor', floor: 0, label: 'North floor 1', source: { sha256: 'a'.repeat(64), url: 'https://plans.example/north-1.pdf' }, buildingId: 'building-north', building: { name: 'North Building', label: 'North Building' } },
        { id: 'north-floor-2', scope: 'floor', floor: 1, label: 'North floor 2', source: { sha256: 'b'.repeat(64), url: 'https://plans.example/north-2.pdf' }, buildingId: 'building-north', building: { name: 'North Building', label: 'North Building' } },
        { id: 'south-floor-1', scope: 'floor', floor: 0, label: 'South floor 1', source: { sha256: 'c'.repeat(64), url: 'https://plans.example/south-1.pdf' }, buildingId: 'building-south', building: { name: 'South Building', label: 'South Building' } },
      ],
      limit: 100, offset: 0, hasMore: false,
    }));
    await page.route('**/floor-plan-archive/catalogue', route => json(route, { buildings: [], sources }));
    await page.route('**/floor-plan-archive/status', route => json(route, { coverage: { agencies: { total: 2, websites: 2 } } }));
    await page.route('**/floor-plan-archive/agencies?*', route => json(route, { agencies }));
    await page.route('**/floor-plan-archive/sites', route => json(route, { sites: [
      { siteKey: 'site-north', label: 'North Site', postings: 2, placed: 1, plans: 2 },
      { siteKey: 'site-south', label: 'South Site', postings: 1, placed: 0, plans: 1 },
    ] }));
    await page.route('**/floor-plan-archive/site?*', route => {
      const key = new URL(route.request().url()).searchParams.get('key');
      return json(route, { siteKey: key, label: key === 'site-south' ? 'South Site' : 'North Site', listingUrl: `https://plans.example/${key}`, siblings: [], envelope: {}, footprint: {}, placements: [] });
    });
    await page.route('**/floor-plan-archive/source/**', route => {
      const source = sources.find(item => new URL(route.request().url()).pathname.endsWith(item.sha256));
      return source ? json(route, source) : route.fulfill({ status: 404, json: { error: 'Source not found' } });
    });

    await page.goto('/floor-plans.html?building=archive');
    const building = page.locator('#building');
    await selectNativeOption(building, 'published:building-north');
    await expect(page.locator('#selection-name')).toHaveText('North Building');
    await selectNativeOption(page.locator('#unit'), '1');
    await expect(page.locator('#source-link a')).toHaveAttribute('href', 'https://plans.example/north-2.pdf');
    await selectNativeOption(building, 'published:building-south');
    await expect(page.locator('#selection-name')).toHaveText('South Building');
    await expect(page.locator('#source-link a')).toHaveAttribute('href', 'https://plans.example/south-1.pdf');
    await page.locator('#tab-sites').click();
    await expect(page.locator('#site-name')).toHaveText('North Site');
    await selectNativeOption(page.locator('#site'), 'site-south');
    await expect(page.locator('#site-name')).toHaveText('South Site');
    const sourceFilter = page.locator('#source-filter');
    await page.locator('#tab-buildings').click();
    await selectNativeOption(building, 'archive');
    await expect(sourceFilter).toBeVisible();
    await sourceFilter.fill('western');
    await expect(page.locator('#unit option')).toHaveCount(1);
    await expect(page.locator('#unit option:checked')).toHaveText('Western cadastral sheet');
    await expect(page.locator('#selection-name')).toHaveText('Western cadastral sheet');

    await page.locator('#tab-agencies').click();
    const agencySearch = page.locator('#agency-search');
    await agencySearch.fill('Northern');
    await expect(page.locator('#agency-count')).toHaveText('1 / 2');
    await expect(page.locator('#agencies tr')).toHaveCount(1);
    await expect(page.locator('#agencies')).toContainText('Northern Registry Office');
    await expect(page.locator('#agencies')).not.toContainText('Southern Survey Agency');
  });

  test('Lens directory and verdict fields select a service and submit its recorded outcome', async ({ mockApi: page }) => {
    const posted: any[] = [];
    await page.route('**/lenses/members', route => json(route, { members: [
      { key: '11111111111111111111111111111111', name: 'North member', serviceUrl: 'https://north-lens.example', coverage: {} },
      { key: 'So11111111111111111111111111111111111111112', name: 'South member', serviceUrl: 'https://south-lens.example', coverage: {} },
    ] }));
    await page.route('**/lens/status', route => {
      const south = route.request().url().includes('south-lens.example');
      return json(route, { key: south ? 'So11111111111111111111111111111111111111112' : '11111111111111111111111111111111', kind: 'permit', identity: 'verified', credential: 'fixture', counts: { ownership: 1 }, pricing: {} });
    });
    await page.route('**/lens/attestations*', route => json(route, { attestations: [] }));
    await page.route('**/lens/verdict', async route => {
      posted.push(route.request().postDataJSON());
      return json(route, { accountHash: 'fixture-verdict-hash', address: '11111111111111111111111111111111' });
    });
    await page.goto('/lens.html');
    await expect(page.locator('#lc-language')).toBeVisible();
    await expect(page.locator('#lc-service-title')).toHaveText('Member service');

    await selectNativeOption(page.locator('#lc-directory'), 'https://south-lens.example');
    await expect(page.locator('#lc-service-url')).toHaveValue('https://south-lens.example');
    await expect(page.locator('#lc-status')).toContainText('verified');

    await selectNativeOption(page.locator('#lc-verdict-kind'), 'expired');
    await expect(page.locator('#lc-verdict-kind')).toHaveValue('expired');
    await page.locator('#lc-verdict-proposal').fill('11111111111111111111111111111111');
    await fillNativeDateTime(page.locator('#lc-verdict-observed'), '2026-10-15T12:34:56');
    await page.locator('#lc-verdict-token').fill('fixture-operator-token');
    await page.locator('#lc-verdict-submit').click();
    await expect(page.locator('#lc-verdict-result')).toContainText('fixture-verdict-hash');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      proposalAccount: '11111111111111111111111111111111',
      verdict: 'expired',
      sourceObservedAt: Math.floor(Date.parse('2026-10-15T12:34:56') / 1000),
    });

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
