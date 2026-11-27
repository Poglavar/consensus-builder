// The plots the homebuyer bots trade (plot-market.json): per city, the lens member that states their
// first holders from its devnet owner registry and confirms sales, and each plot as its parcel source
// gives it. Plots then go through the same USDC offer market as the flats of executed rounds.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Offer = require('../../frontend/js/property-offer-record.js');
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plot-market.json');

export function loadPlotMarkets(file = FILE) {
    return JSON.parse(fs.readFileSync(file, 'utf8')).markets || [];
}

/** A lens member persona's name, or a key, as the member's key. */
const memberKey = (personas, lens) => personas.find(p => p.role === 'lens-member' && p.name === lens)?.wallet ?? lens;

/**
 * The plots of these cities as tradable assets:
 * [{ key, title, label, city, asset: { kind: 'parcel', sourceId, id, at }, assetHash, lens }].
 * `lens` is the member's key; a market whose member has no key yet is left out.
 */
export function plotAssets({ cities, personas, markets = loadPlotMarkets() }) {
    const out = [];
    for (const market of markets.filter(item => cities.includes(item.city))) {
        const lens = memberKey(personas, market.lens);
        if (!lens) continue;
        for (const plot of market.plots || []) {
            const asset = Offer.normalizeAsset({ kind: 'parcel', sourceId: market.sourceId, id: plot.id, at: plot.at }, market.city);
            out.push({ key: plot.id, title: plot.label, label: plot.label, city: market.city, asset, assetHash: Offer.assetHash(asset), lens });
        }
    }
    return out;
}

/** The plots whose first holders this lens member states (its key), with their city. */
export function plotsOfMember({ member, personas, markets = loadPlotMarkets() }) {
    return plotAssets({ cities: [...new Set(markets.map(item => item.city))], personas, markets }).filter(plot => plot.lens === member);
}
