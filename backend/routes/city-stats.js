// City comparison / cost-of-living stats
// GET /city-stats/cities         - list of cities with available data
// GET /city-stats/snapshots      - all snapshots (city + date), optional ?city=Zagreb
// GET /city-stats/data           - metric-scoped values when ?metric=salary_net is provided,
//                                  otherwise full raw_data for given city(ies) and optional date range
//                                  ?cities=Zagreb,Ljubljana&from=2025-01-01&to=2026-12-31&metric=salary_net

const exchangeRateCache = new Map();
const FX_LOOKBACK_DAYS = 7;
const FX_FETCH_TIMEOUT_MS = 5000;
const CITY_METRICS = [
    {
        key: 'salary_net',
        format: 'currency',
        aliases: ['Average Monthly Net Salary (After Tax)']
    },
    {
        key: 'rent_1br_center',
        format: 'currency',
        aliases: ['Apartment (1 bedroom) in City Centre', '1 Bedroom Apartment in City Centre']
    },
    {
        key: 'rent_1br_outside',
        format: 'currency',
        aliases: ['Apartment (1 bedroom) Outside of Centre', '1 Bedroom Apartment Outside of Centre']
    },
    {
        key: 'buy_m2_center',
        format: 'currency',
        aliases: ['Price per Square Meter to Buy Apartment in City Centre', 'Price per Square Meter to Buy an Apartment in the City Centre']
    },
    {
        key: 'buy_m2_outside',
        format: 'currency',
        aliases: ['Price per Square Meter to Buy Apartment Outside of Centre', 'Price per Square Meter to Buy an Apartment Outside of the Centre']
    },
    {
        key: 'meal_inexpensive',
        format: 'currency',
        aliases: ['Meal, Inexpensive Restaurant', 'Meal at an Inexpensive Restaurant']
    },
    {
        key: 'utilities_85m2',
        format: 'currency',
        aliases: ['Basic (Electricity, Heating, Cooling, Water, Garbage) for 85m2 Apartment', 'Basic Utilities for 915 sq ft Apartment Including Electricity, Heating, Cooling, Water, and Garbage']
    },
    {
        key: 'internet',
        format: 'currency',
        aliases: ['Internet (60 Mbps or More, Unlimited Data, Cable/ADSL)', 'Internet (60 Mbps or More, Unlimited Data, Cable/ADSL/5G)']
    },
    {
        key: 'local_ticket',
        format: 'currency',
        aliases: ['One-way Ticket (Local Transport)', 'One-Way Ticket on Local Transport']
    },
    {
        key: 'gasoline_liter',
        format: 'currency',
        aliases: ['Gasoline (1 liter)']
    },
    {
        key: 'mortgage_rate',
        format: 'number',
        aliases: ['Mortgage Interest Rate in Percentages (%), Yearly, for 20 Years Fixed-Rate', 'Mortgage Interest Rate for 20 Years, Yearly, Fixed-Rate']
    }
];
const CITY_METRICS_BY_KEY = new Map(CITY_METRICS.map(metric => [metric.key, metric]));

function parseNumericValue(raw) {
    if (raw === undefined || raw === null) return null;
    const normalized = String(raw).replace(/\u00a0/g, ' ').replace(/,/g, '').trim();
    const match = normalized.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
}

function detectCurrencyFromPrice(raw) {
    const value = String(raw || '');
    if (!value.trim()) return null;
    if (value.includes('€')) return 'EUR';
    if (value.includes('Ft')) return 'HUF';
    if (value.includes('Kč')) return 'CZK';
    if (value.includes('RSD')) return 'RSD';
    if (/\bDIN\b/i.test(value)) return 'RSD';
    if (/дин/i.test(value) || /Дин/.test(value)) return 'RSD';
    if (value.includes('zł') || /\bPLN\b/.test(value)) return 'PLN';
    if (value.includes('KM') || /\bBAM\b/.test(value)) return 'BAM';
    if (/\blei\b/i.test(value) || /\bleu\b/i.test(value) || /\bRON\b/.test(value)) return 'RON';
    if (value.includes('лв') || /\bBGN\b/.test(value)) return 'BGN';
    if (/\bGBP\b/i.test(value)) return 'GBP';
    if (/\bUSD\b/i.test(value)) return 'USD';
    if (value.includes('$')) return 'USD';
    if (value.includes('£')) return 'GBP';
    return null;
}

function detectRowCurrency(rawData) {
    const prices = Array.isArray(rawData?.prices) ? rawData.prices : [];
    for (const entry of prices) {
        const currency = detectCurrencyFromPrice(entry?.price);
        if (currency) return currency;
    }
    return 'EUR';
}

function normalizeFxDate(date) {
    if (date instanceof Date) {
        return date.toISOString().slice(0, 10);
    }
    const raw = String(date || '').trim();
    if (!raw) return raw;
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
        return raw.slice(0, 10);
    }
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString().slice(0, 10);
    }
    return raw;
}

function shiftFxDate(date, days) {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return date;
    parsed.setUTCDate(parsed.getUTCDate() + days);
    return parsed.toISOString().slice(0, 10);
}

function getExchangeRateCacheKey(currency, date) {
    return `${currency}:${date}`;
}

async function fetchWithTimeout(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FX_FETCH_TIMEOUT_MS);

    try {
        return await fetch(url, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'consensus-builder/city-stats'
            }
        });
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchFrankfurterRateToEur(currency, date) {
    try {
        const frankfurterUrl = `https://api.frankfurter.app/${encodeURIComponent(date)}?from=${encodeURIComponent(currency)}&to=EUR`;
        const response = await fetchWithTimeout(frankfurterUrl);

        if (!response.ok) {
            return null;
        }

        const payload = await response.json();
        const rate = payload?.rates?.EUR;
        return Number.isFinite(rate) ? rate : null;
    } catch (_) {
        return null;
    }
}

async function fetchFrankfurterTimeSeriesToEur(currency, dates) {
    if (!Array.isArray(dates) || dates.length === 0) {
        return new Map();
    }

    const sortedDates = [...new Set(dates.map(normalizeFxDate))].sort();
    const fromDate = shiftFxDate(sortedDates[0], -3);
    const toDate = sortedDates[sortedDates.length - 1];

    try {
        const url = `https://api.frankfurter.app/${encodeURIComponent(fromDate)}..${encodeURIComponent(toDate)}?from=${encodeURIComponent(currency)}&to=EUR`;
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            return new Map();
        }

        const payload = await response.json();
        const rawRates = payload?.rates;
        if (!rawRates || typeof rawRates !== 'object') {
            return new Map();
        }

        const availableDates = Object.keys(rawRates).sort();
        const ratesByDate = new Map();
        let latestRate = null;
        let availableIndex = 0;

        for (const requestedDate of sortedDates) {
            while (availableIndex < availableDates.length && availableDates[availableIndex] <= requestedDate) {
                const candidateRate = rawRates[availableDates[availableIndex]]?.EUR;
                if (Number.isFinite(candidateRate)) {
                    latestRate = candidateRate;
                }
                availableIndex += 1;
            }

            if (Number.isFinite(latestRate)) {
                ratesByDate.set(requestedDate, latestRate);
            }
        }

        return ratesByDate;
    } catch (_) {
        return new Map();
    }
}

async function fetchCurrencyApiRateToEur(currency, date) {
    const fallbackUrl = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${encodeURIComponent(date)}/v1/currencies/${encodeURIComponent(currency.toLowerCase())}.json`;
    const response = await fetchWithTimeout(fallbackUrl);

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        throw new Error(`FX status ${response.status} for ${currency} ${date}`);
    }

    const payload = await response.json();
    const rate = payload?.[currency.toLowerCase()]?.eur;
    if (!Number.isFinite(rate)) {
        throw new Error(`FX rate missing for ${currency} ${date}`);
    }

    return rate;
}

async function resolveExchangeRateToEur(currency, normalizedDate) {
    const frankfurterRate = await fetchFrankfurterRateToEur(currency, normalizedDate);
    if (Number.isFinite(frankfurterRate)) {
        return frankfurterRate;
    }

    let lastError = null;

    for (let offset = 0; offset <= FX_LOOKBACK_DAYS; offset += 1) {
        const candidateDate = shiftFxDate(normalizedDate, -offset);
        try {
            const fallbackRate = await fetchCurrencyApiRateToEur(currency, candidateDate);
            if (Number.isFinite(fallbackRate)) {
                return fallbackRate;
            }
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error(`FX rate missing for ${currency} ${normalizedDate}`);
}

async function fetchExchangeRateToEur(currency, date) {
    const normalizedCurrency = String(currency || '').trim().toUpperCase();
    if (!normalizedCurrency || normalizedCurrency === 'EUR') return 1;

    const normalizedDate = normalizeFxDate(date);
    const cacheKey = getExchangeRateCacheKey(normalizedCurrency, normalizedDate);
    if (exchangeRateCache.has(cacheKey)) {
        return exchangeRateCache.get(cacheKey);
    }

    const pendingRate = resolveExchangeRateToEur(normalizedCurrency, normalizedDate)
        .catch(error => {
            exchangeRateCache.delete(cacheKey);
            throw error;
        });

    exchangeRateCache.set(cacheKey, pendingRate);
    return pendingRate;
}

async function warmExchangeRateCache(rows) {
    const datesByCurrency = new Map();

    for (const row of rows) {
        const currency = String(detectCurrencyFromPrice(row?.price) || 'EUR').toUpperCase();
        if (currency === 'EUR') {
            continue;
        }

        const normalizedDate = normalizeFxDate(row?.updated_at);
        if (!normalizedDate) {
            continue;
        }

        if (!datesByCurrency.has(currency)) {
            datesByCurrency.set(currency, new Set());
        }

        datesByCurrency.get(currency).add(normalizedDate);
    }

    await Promise.all(Array.from(datesByCurrency.entries()).map(async ([currency, dateSet]) => {
        const ratesByDate = await fetchFrankfurterTimeSeriesToEur(currency, Array.from(dateSet));

        for (const [date, rate] of ratesByDate.entries()) {
            exchangeRateCache.set(getExchangeRateCacheKey(currency, date), rate);
        }
    }));
}

async function enrichRowWithEur(row) {
    const prices = Array.isArray(row.raw_data?.prices) ? row.raw_data.prices : [];
    const currency = detectRowCurrency(row.raw_data);

    try {
        const fxToEur = await fetchExchangeRateToEur(currency, row.updated_at);

        return {
            ...row,
            currency,
            fx_to_eur: fxToEur,
            raw_data: {
                ...row.raw_data,
                currency,
                fx_to_eur: fxToEur,
                prices: prices.map(entry => {
                    const numeric = parseNumericValue(entry?.price);
                    return {
                        ...entry,
                        price_eur: Number.isFinite(numeric) ? numeric * fxToEur : null
                    };
                })
            }
        };
    } catch (error) {
        console.error('[city-stats] eur enrichment failed', {
            city: row.city,
            updated_at: normalizeFxDate(row.updated_at),
            currency,
            message: error?.message || String(error)
        });

        return {
            ...row,
            currency,
            fx_to_eur: null,
            raw_data: {
                ...row.raw_data,
                currency,
                fx_to_eur: null,
                eur_error: 'EUR normalization failed',
                prices: prices.map(entry => ({
                    ...entry,
                    price_eur: null
                }))
            }
        };
    }
}

async function enrichMetricRow(metric, row) {
    const numericValue = parseNumericValue(row.price);
    if (!Number.isFinite(numericValue)) {
        return {
            city: row.city,
            updated_at: row.updated_at,
            item: row.item,
            currency: null,
            fx_to_eur: null,
            value: null,
            value_eur: null
        };
    }

    if (metric.format !== 'currency') {
        return {
            city: row.city,
            updated_at: row.updated_at,
            item: row.item,
            currency: null,
            fx_to_eur: null,
            value: numericValue,
            value_eur: null
        };
    }

    const currency = detectCurrencyFromPrice(row.price) || 'EUR';

    try {
        const fxToEur = await fetchExchangeRateToEur(currency, row.updated_at);

        return {
            city: row.city,
            updated_at: row.updated_at,
            item: row.item,
            currency,
            fx_to_eur: fxToEur,
            value: numericValue,
            value_eur: numericValue * fxToEur
        };
    } catch (error) {
        console.error('[city-stats] metric eur enrichment failed', {
            city: row.city,
            updated_at: normalizeFxDate(row.updated_at),
            currency,
            item: row.item,
            message: error?.message || String(error)
        });

        return {
            city: row.city,
            updated_at: row.updated_at,
            item: row.item,
            currency,
            fx_to_eur: null,
            value: numericValue,
            value_eur: null,
            eur_error: 'EUR normalization failed'
        };
    }
}

export function setupCityStatsRoute(app, pool) {
    // List all cities that have data, with first/last snapshot dates
    app.get('/city-stats/cities', async (_req, res) => {
        const sql = `
            SELECT city,
                   MIN(updated_at) AS first_snapshot,
                   MAX(updated_at) AS last_snapshot,
                   COUNT(*)::int   AS snapshot_count
            FROM numbeo_city
            GROUP BY city
            ORDER BY city
        `;
        try {
            const result = await pool.query(sql);
            res.json(result.rows);
        } catch (err) {
            console.error('[city-stats] /cities error', err);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // List snapshots (city + date), optionally filtered by city
    app.get('/city-stats/snapshots', async (req, res) => {
        const cityRaw = (req.query.city || '').trim();
        const params = [];
        let sql = `SELECT city, updated_at FROM numbeo_city`;
        if (cityRaw) {
            params.push(cityRaw);
            sql += ` WHERE city = $1`;
        }
        sql += ` ORDER BY city, updated_at`;
        try {
            const result = await pool.query(sql, params);
            res.json(result.rows);
        } catch (err) {
            console.error('[city-stats] /snapshots error', err);
            res.status(500).json({ error: 'Database error' });
        }
    });

    // Full data for given cities + optional date range.
    // When ?metric=salary_net is provided, returns a lean metric-scoped payload.
    // ?cities=Zagreb,Ljubljana&from=2025-01-01&to=2026-12-31&metric=salary_net
    app.get('/city-stats/data', async (req, res) => {
        const citiesRaw = (req.query.cities || '').trim();
        const fromRaw = (req.query.from || '').trim();
        const toRaw = (req.query.to || '').trim();
        const metricKey = (req.query.metric || '').trim();
        const metric = metricKey ? CITY_METRICS_BY_KEY.get(metricKey) || null : null;

        if (metricKey && !metric) {
            res.status(400).json({ error: `Unknown metric: ${metricKey}` });
            return;
        }

        const cities = citiesRaw
            ? citiesRaw.split(',').map(c => c.trim()).filter(Boolean)
            : [];

        const params = [];
        const clauses = [];

        if (cities.length > 0) {
            params.push(cities);
            clauses.push(`city = ANY($${params.length})`);
        }
        if (fromRaw) {
            const d = new Date(fromRaw);
            if (!Number.isNaN(d.getTime())) {
                params.push(d.toISOString().slice(0, 10));
                clauses.push(`updated_at >= $${params.length}`);
            }
        }
        if (toRaw) {
            const d = new Date(toRaw);
            if (!Number.isNaN(d.getTime())) {
                params.push(d.toISOString().slice(0, 10));
                clauses.push(`updated_at <= $${params.length}`);
            }
        }

        try {
            if (metric) {
                params.push(metric.aliases);
                const aliasParam = `$${params.length}`;

                let sql = `
                    SELECT city,
                           updated_at,
                           matched.metric_entry->>'item'  AS item,
                           matched.metric_entry->>'price' AS price
                    FROM numbeo_city
                    CROSS JOIN LATERAL (
                        SELECT entry AS metric_entry
                        FROM jsonb_array_elements(COALESCE(raw_data::jsonb->'prices', '[]'::jsonb)) AS entries(entry)
                        WHERE entry->>'item' = ANY(${aliasParam})
                        LIMIT 1
                    ) AS matched
                `;

                if (clauses.length > 0) {
                    sql += ` WHERE ${clauses.join(' AND ')}`;
                }

                sql += ` ORDER BY city, updated_at`;

                const result = await pool.query(sql, params);
                if (metric.format === 'currency') {
                    await warmExchangeRateCache(result.rows);
                }
                const enrichedRows = await Promise.all(result.rows.map(row => enrichMetricRow(metric, row)));
                res.json(enrichedRows);
                return;
            }

            let sql = `SELECT city, updated_at, raw_data FROM numbeo_city`;
            if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
            sql += ` ORDER BY city, updated_at`;

            const result = await pool.query(sql, params);
            const enrichedRows = await Promise.all(result.rows.map(enrichRowWithEur));
            res.json(enrichedRows);
        } catch (err) {
            console.error('[city-stats] /data error', err);
            res.status(500).json({ error: 'Database error' });
        }
    });
}
