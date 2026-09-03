import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const frontendRoot = fileURLToPath(new URL('../../frontend/js', import.meta.url));
const walk = directory => readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
});
const files = walk(frontendRoot).filter(path => path.endsWith('.js'));
const rel = path => relative(frontendRoot, path);
const read = path => readFileSync(path, 'utf8');

describe('authoritative parcel source contracts', () => {
    it('has one live-fabric singleton and one mutation serializer', () => {
        const singletonCalls = files.flatMap(path => (
            [...read(path).matchAll(/createLiveParcelFabric\s*\(\s*\)/g)].map(() => rel(path))
        ));
        expect(singletonCalls).toEqual(['parcels/live-fabric.js']);

        const retiredMutationPlumbing = /\b(?:_fabricChangeTail|_fabricQueue|_fabricTransaction|currentTransaction|__activeParcelFabricDomainTransaction|_activeFabricTransaction)\b/;
        files.forEach(path => expect(read(path), rel(path)).not.toMatch(retiredMutationPlumbing));

        const directFabricBegins = files.filter(path => /\.beginMutation(?:\?\.)?\s*\(/.test(read(path))).map(rel);
        expect(directFabricBegins).toEqual(['proposals/apply/transaction.js']);
    });

    it('keeps cadastral transport and arbitrary ingestion private', () => {
        const transportFiles = files.filter(path => (
            /fetch\s*\([\s\S]{0,180}\/(?:parcels\/under|road-parcels)\b/.test(read(path))
        )).map(rel);
        expect(transportFiles).toEqual(['parcels/fetch.js']);

        const publicIngestion = /\b(?:ingestCadastralParcelFeatures|acceptFeatures)\b/;
        files.forEach(path => expect(read(path), rel(path)).not.toMatch(publicIngestion));
    });

    it('keeps retired land fields inside explicit rejection boundaries', () => {
        const allowed = new Set([
            'minted-proposals.js',
            'parcels/live-fabric.js',
            'proposals/authored-record.js',
            'proposals/chain-proposal-loader.js',
            'proposals/data.js',
            'solana/blockchain-sync.js'
        ]);
        const names = [
            'ancestorParcelIds', 'ancestorProposal', 'baseParcelIds', 'originalParcelIds',
            'parentParcelId', 'parentParcelIds', 'sourceParcelId', 'sourceParcelIds'
        ].join('|');
        const retiredFieldAccess = new RegExp(`(?:\\?\\.|\\.)\\s*(?:${names})\\b|\\b(?:${names})\\s*:|['\"](?:${names})['\"]`);

        files.filter(path => !allowed.has(rel(path))).forEach(path => {
            expect(read(path), rel(path)).not.toMatch(retiredFieldAccess);
        });
    });

    it('keeps cadastral Leaflet geometry inside presentation code', () => {
        const allowed = new Set(['map-load-debug.js', 'parcels/presenter.js']);
        const layerFeatureAccess = /\blayer\??\.feature\b/;
        files.filter(path => !allowed.has(rel(path))).forEach(path => {
            expect(read(path), rel(path)).not.toMatch(layerFeatureAccess);
        });
    });

    it('exposes ID-based building editors without compatibility aliases', () => {
        const editorFiles = [
            'building-blocks.js', 'single-building.js', 'row-house.js', 'parcel-based.js'
        ].map(path => read(join(frontendRoot, path))).join('\n');
        expect(editorFiles).not.toContain('openBlockifyForParcels');
        expect(editorFiles).not.toMatch(/open(?:UrbanRule|SingleBuilding|RowHouse|ParcelBased)ForParcels\s*\(\s*\{[^}]*\bparcels\b/);
        expect(editorFiles).toMatch(/openUrbanRuleForParcels\s*\(\s*\{[^}]*\bparcelIds\b/);
        expect(editorFiles).toMatch(/openSingleBuildingForParcels\s*\(\s*\{[^}]*\bparcelIds\b/);
    });

    it('does not retain invalid proposals in a secondary collection', () => {
        const retentionTerm = ['quaran', 'tine'].join('');
        const source = files.map(read).join('\n').toLowerCase();
        expect(source).not.toContain(retentionTerm);
    });
});
