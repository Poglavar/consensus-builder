// Renders the research snapshot; every table shares numeric-aware, reversible header sorting.
import { nextSort, sortRows, filterCities, filterCountries } from './parcel-coverage-report-model.mjs?v=2';
import { reportMessages } from './parcel-coverage-report-i18n.mjs?v=2';

const params = new URLSearchParams(location.search);
let language = Object.hasOwn(reportMessages, params.get('lang')) ? params.get('lang') : 'en';
const validCohorts = new Set(['all', 'largest200', 'growth200', 'growth-top20']);
const initialCohort = validCohorts.has(params.get('cohort')) ? params.get('cohort') : 'all';
const isGrowthCohort = cohort => cohort === 'growth200' || cohort === 'growth-top20';
let report;
const sorts = { cities: { key: 'name', direction: 'asc' }, countries: { key: 'name', direction: 'asc' }, breakdown: { key: 'landAreaKm2', direction: 'desc' } };
if (isGrowthCohort(initialCohort)) sorts.cities = { key: 'annualGrowthPct2015To2025', direction: 'desc' };
const byId = id => document.getElementById(id);
const tr = (key, values = {}) => (reportMessages[language]?.[key] || reportMessages.en[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const number = value => numeric(value) ? new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(value) : '—';
const percentage = value => numeric(value) ? `${new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}%` : '—';
const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
};
const categoryKey = id => ({ national: 'categoryNational', local: 'categoryLocal', none: 'categoryNone', unknown: 'categoryUnknown' })[id];

const columns = {
    cities: [
        ['name', 'city'], ['population2025', 'populationEstimate', 'number'], ['annualGrowthPct2015To2025', 'growthEstimate', 'number'],
        ['country', 'country'], ['checked', 'checked'], ['checkedDate', 'checkedDate'], ['registryFound', 'registryFound'],
        ['impliedParcelsTried', 'impliedTried'], ['osmUrl', 'osm'], ['googleMapsUrl', 'google'], ['wikipediaUrl', 'wiki']
    ],
    countries: [['name', 'countryName'], ['citiesChecked', 'citiesChecked', 'number'], ['citiesWithRegistry', 'citiesFound', 'number'], ['nationalCadastreFound', 'nationalFound']],
    breakdown: [
        ['label', 'evidence'], ['jurisdictions', 'jurisdictions', 'number'], ['landAreaKm2', 'landKm2', 'number'], ['landAreaKm2Pct', 'landShare', 'number'],
        ['builtUpAreaKm2', 'builtKm2', 'number'], ['builtUpAreaKm2Pct', 'builtShare', 'number'], ['population', 'population', 'number'], ['populationPct', 'populationShare', 'number']
    ]
};
const tableId = { cities: 'city-table', countries: 'country-table', breakdown: 'breakdown-table' };

function applyLanguage() {
    document.documentElement.lang = language;
    document.title = tr('title');
    document.querySelectorAll('[data-t]').forEach(element => { element.textContent = tr(element.dataset.t); });
    document.querySelectorAll('[data-aria-t]').forEach(element => element.setAttribute('aria-label', tr(element.dataset.ariaT)));
    document.querySelectorAll('[data-table-region]').forEach(element => element.setAttribute('aria-label', tr(element.dataset.tableRegion === 'breakdown' ? 'breakdownCaption' : element.dataset.tableRegion === 'cities' ? 'cityTitle' : 'countryTitle')));
    byId('report-language').value = language;
    byId('report-language').setAttribute('aria-label', tr('language'));
}

function safeLink(url, label, title) {
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return node('span', '—', 'muted');
        const anchor = node('a', label, 'cell-link');
        anchor.href = parsed.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
        if (title) anchor.title = title;
        return anchor;
    } catch { return node('span', '—', 'muted'); }
}

function status(value, unknownKey = 'unknown') {
    return node('span', tr(value === true ? 'yes' : value === false ? 'no' : unknownKey), `status status-${value === true ? 'yes' : value === false ? 'no' : 'unknown'}`);
}

function renderHeader(kind) {
    const row = node('tr');
    for (const [key, label, className] of columns[kind]) {
        const th = node('th', undefined, className); th.scope = 'col';
        const selected = sorts[kind].key === key;
        th.setAttribute('aria-sort', selected ? sorts[kind].direction === 'asc' ? 'ascending' : 'descending' : 'none');
        const button = node('button'); button.type = 'button'; button.dataset.sortKey = key;
        button.setAttribute('aria-label', `${tr(label)}: ${tr(nextSort(sorts[kind], key).direction === 'asc' ? 'sortAsc' : 'sortDesc')}`);
        const mark = node('span', selected ? sorts[kind].direction === 'asc' ? '↑' : '↓' : '↕', 'sort-mark'); mark.setAttribute('aria-hidden', 'true');
        button.append(node('span', tr(label)), mark);
        button.addEventListener('click', () => { sorts[kind] = nextSort(sorts[kind], key); renderTable(kind); });
        th.append(button); row.append(th);
    }
    byId(tableId[kind]).tHead.replaceChildren(row);
}

function cityCell(city, key, className) {
    const td = node('td', undefined, className);
    if (key === 'name') {
        td.append(node('strong', city.name));
        if (city.appCityIds.length) td.append(node('span', tr('inApp'), 'cell-detail'));
    } else if (key === 'population2025' || key === 'annualGrowthPct2015To2025') {
        td.textContent = key === 'population2025' ? number(city[key]) : percentage(city[key]);
        td.title = city.population2025 !== null ? tr('populationMatch', { name: city.wupName || city.name, quality: city.populationPlausibility2025 || tr('unknown') }) : tr('unknownValue');
    } else if (key === 'checked' || key === 'registryFound' || key === 'impliedParcelsTried') {
        td.append(status(city[key], key === 'impliedParcelsTried' ? 'notRecorded' : 'unknown'));
        if (key === 'registryFound' && city[key] === true) td.append(node('span', tr(city.verifiedSample ? 'verifiedSample' : 'samplePending'), 'cell-detail'));
        if (key === 'registryFound') {
            td.title = [city.registryBasis, ...city.evidenceUrls].filter(Boolean).join('\n');
            if (city.evidenceUrls.length) {
                const badge = td.firstChild;
                const link = safeLink(city.evidenceUrls[0], '', td.title);
                link.append(badge); td.prepend(link);
            }
        }
    } else if (key === 'checkedDate') {
        td.textContent = city.checkedDate || '—';
        if (city.checkedDateEvidence) td.title = `${city.checkedDateEvidence.path || ''} · ${city.checkedDateEvidence.field || ''}`;
    } else if (['osmUrl', 'googleMapsUrl', 'wikipediaUrl'].includes(key)) {
        td.append(city[key] ? safeLink(city[key], tr(key === 'wikipediaUrl' ? 'article' : 'map'), city.name) : node('span', '—', 'muted'));
    } else td.textContent = city[key] ?? '—';
    return td;
}

function countryStatusNote(country) {
    return tr(({ national_online_cadastre_verified_sample: 'countrySample', national_cadastre_credentialed_or_paid: 'countryGated', national_cadastre_viewer_only: 'countryViewer', covered_by_parent_source: 'countryParent', partial_or_unofficial_sample: 'countryPartial', temporarily_unavailable: 'countryUnavailable', subnational_only: 'countryRegional', no_online_cadastre_found: 'countryNone' })[country.probeStatus] || 'countryUnchecked');
}

function countryCell(country, key, className) {
    const td = node('td', undefined, className);
    if (key === 'name') {
        const button = node('button', country.name, 'country-name'); button.type = 'button';
        button.title = tr('showCountryCities', { country: country.name });
        button.addEventListener('click', () => {
            byId('city-country').value = country.code; byId('city-search').value = ''; byId('city-checked').value = 'all'; byId('city-registry').value = 'all'; byId('city-cohort').value = 'all';
            const url = new URL(location.href); url.searchParams.delete('cohort'); url.hash = 'cities'; history.replaceState(null, '', url);
            renderTable('cities'); byId('cities').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        });
        td.append(button, node('span', `${country.code}${country.statisticsIncluded === false ? ` · ${tr('supplementary')}` : country.landAreaKm2 === null ? ` · ${tr('noStatistics')}` : ''}`, 'cell-detail'));
    } else if (key === 'nationalCadastreFound') {
        td.append(status(country[key]), node('span', countryStatusNote(country), 'cell-detail'));
        if (country.evidenceUrls.length) td.title = country.evidenceUrls.join('\n');
    } else td.textContent = number(country[key]);
    return td;
}

function renderTable(kind) {
    renderHeader(kind);
    let rows;
    if (kind === 'cities') rows = filterCities(report.cities, { query: byId('city-search').value, checked: byId('city-checked').value, registry: byId('city-registry').value, country: byId('city-country').value, cohort: byId('city-cohort').value });
    else if (kind === 'countries') rows = filterCountries(report.countries, { query: byId('country-search').value, category: byId('country-category').value });
    else rows = report.breakdown.map(row => ({ ...row, label: tr(categoryKey(row.id)) }));
    rows = sortRows(rows, sorts[kind], language);
    const fragment = document.createDocumentFragment();
    for (const item of rows) {
        const row = node('tr');
        row.dataset.recordId = item.id || item.code;
        for (const [key, , className] of columns[kind]) {
            if (kind === 'cities') row.append(cityCell(item, key, className));
            else if (kind === 'countries') row.append(countryCell(item, key, className));
            else {
                const td = node('td', undefined, className);
                if (key === 'label') { td.classList.add('category-cell'); td.append(node('span', '', `category-dot ${item.id}`), node('span', item.label)); }
                else td.textContent = key.endsWith('Pct') ? percentage(item[key]) : number(item[key]);
                row.append(td);
            }
        }
        fragment.append(row);
    }
    if (!rows.length) { const row = node('tr'); const td = node('td', tr('noRows'), 'empty-row'); td.colSpan = columns[kind].length; row.append(td); fragment.append(row); }
    byId(tableId[kind]).tBodies[0].replaceChildren(fragment);
    if (kind !== 'breakdown') byId(kind === 'cities' ? 'city-count' : 'country-count').textContent = tr('rowsShown', { shown: number(rows.length), total: number(report[kind].length) });
}

function renderSummary() {
    const meta = report.metadata;
    byId('snapshot-date').textContent = tr('snapshot', { date: meta.asOf });
    byId('summary-cards').replaceChildren(...[
        ['cardChecked', meta.checkedCityCount], ['cardFound', meta.cityRegistryFoundCount], ['cardNational', meta.nationalCadastreCount], ['cardQueued', meta.uncheckedCityCount]
    ].map(([key, value]) => { const card = node('article', undefined, 'summary-card'); card.append(node('strong', number(value)), node('span', tr(key))); return card; }));
    byId('metric-charts').replaceChildren(...[['landAreaKm2', 'landArea'], ['builtUpAreaKm2', 'builtUpArea'], ['population', 'population']].map(([key, label]) => {
        const chart = node('article', undefined, 'metric-chart');
        const percent = report.breakdown.filter(row => row.id === 'national' || row.id === 'local').reduce((sum, row) => sum + row[`${key}Pct`], 0);
        const bar = node('div', undefined, 'stacked-bar');
        for (const row of report.breakdown) {
            const segment = node('button', undefined, `bar-segment ${row.id}`); segment.type = 'button';
            segment.style.width = `${row[`${key}Pct`]}%`;
            segment.title = `${tr(categoryKey(row.id))}: ${percentage(row[`${key}Pct`])}`;
            segment.setAttribute('aria-label', `${tr(label)} · ${segment.title}`);
            segment.addEventListener('click', () => { byId('country-category').value = row.id; byId('country-search').value = ''; renderTable('countries'); byId('countries').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); });
            bar.append(segment);
        }
        chart.append(node('h3', tr(label)), node('p', percentage(percent), 'metric-value'), node('p', tr('metricLabel'), 'metric-label'), bar); return chart;
    }));
    byId('denominator-note').textContent = tr('denominatorNote', { land: number(report.world.landAreaKm2), built: number(report.world.builtUpAreaKm2), population: number(report.world.population), count: number(meta.statisticalJurisdictions) });
    byId('roster-note').textContent = tr('rosterNote', { count: number(report.countries.length) });
    byId('quality-details').replaceChildren(...[
        tr('qualityPopulation', { matched: number(meta.populationMatchedCount), total: number(report.cities.length), growth: number(meta.growthMatchedCount) }),
        tr('qualityRegistry', { found: number(meta.cityRegistryFoundCount), verified: number(meta.verifiedCitySampleCount) }),
        tr('qualityDates', { missing: number(meta.checkedCitiesMissingDate) }), tr('qualityWiki', { linked: number(meta.wikiCityCount) }),
        tr('qualityArea'), tr('qualityInferred'), tr('qualitySamples', { count: number(meta.countryTwoRegionCount) }), tr('qualityRoster')
    ].map(text => node('p', text)));
    byId('report-sources').replaceChildren(...report.sources.map(source => {
        const item = node('li'); item.append(safeLink(source.url, source.name));
        if (source.accessedAt) item.append(node('span', ` · ${tr('sourceDate', { date: source.accessedAt })}`));
        return item;
    }));
}

function render() {
    applyLanguage(); renderSummary();
    const selected = byId('city-country').value;
    byId('city-country').replaceChildren(new Option(tr('all'), ''), ...sortRows(report.countries, { key: 'name', direction: 'asc' }, language).map(country => new Option(country.name, country.code)));
    byId('city-country').value = selected;
    for (const kind of Object.keys(columns)) renderTable(kind);
}

byId('report-language').addEventListener('change', event => {
    language = event.target.value;
    const url = new URL(location.href); url.searchParams.set('lang', language); history.replaceState(null, '', url);
    if (report) render(); else applyLanguage();
});
byId('print-report').addEventListener('click', () => window.print());
for (const id of ['city-search', 'city-checked', 'city-registry', 'city-country']) byId(id).addEventListener(id.endsWith('search') ? 'input' : 'change', () => renderTable('cities'));
byId('city-cohort').value = initialCohort;
byId('city-cohort').addEventListener('change', event => {
    const cohort = validCohorts.has(event.target.value) ? event.target.value : 'all';
    event.target.value = cohort;
    if (isGrowthCohort(cohort)) sorts.cities = { key: 'annualGrowthPct2015To2025', direction: 'desc' };
    const url = new URL(location.href);
    if (cohort === 'all') url.searchParams.delete('cohort'); else url.searchParams.set('cohort', cohort);
    history.replaceState(null, '', url);
    renderTable('cities');
});
for (const id of ['country-search', 'country-category']) byId(id).addEventListener(id.endsWith('search') ? 'input' : 'change', () => renderTable('countries'));
applyLanguage();
try {
    const response = await fetch('data/parcel-coverage-report.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Report data HTTP ${response.status}`);
    report = await response.json();
    if (!Array.isArray(report.cities) || !Array.isArray(report.countries) || !Array.isArray(report.breakdown)) throw new Error('Invalid report data');
    render(); byId('load-status').hidden = true; byId('report-content').hidden = false;
    if (location.hash === '#cities') requestAnimationFrame(() => byId('cities').scrollIntoView({ behavior: 'instant' }));
} catch (error) {
    console.error('Parcel coverage report:', error);
    byId('load-status').textContent = tr('loadError'); byId('load-status').className = 'load-error';
}
