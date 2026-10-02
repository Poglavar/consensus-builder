import { describe, expect, it } from 'vitest';
import { parse } from '@babel/parser';
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
        // Resolve local URL variables as well as inline URLs; moving a URL into `path` must not
        // hide a transport, while an unrelated fetch in a city config must not count as one.
        const targetsParcels = source => {
            let found = false;
            const urlText = (node, bindings, seen = new Set()) => {
                if (!node) return '';
                if (node.type === 'Identifier') {
                    if (seen.has(node.name)) return '';
                    return urlText(bindings.get(node.name), bindings, new Set([...seen, node.name]));
                }
                if (node.type === 'StringLiteral') return node.value;
                if (node.type === 'TemplateLiteral') return node.quasis.map(q => q.value.raw).join('')
                    + node.expressions.map(n => urlText(n, bindings, seen)).join('');
                if (node.type === 'ConditionalExpression') return urlText(node.consequent, bindings, seen) + urlText(node.alternate, bindings, seen);
                if (node.type === 'BinaryExpression') return urlText(node.left, bindings, seen) + urlText(node.right, bindings, seen);
                return '';
            };
            const walkAst = (node, bindings = new Map()) => {
                if (!node || typeof node.type !== 'string') return;
                if (/Function/.test(node.type)) bindings = new Map(bindings);
                if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') bindings.set(node.id.name, node.init);
                if (node.type === 'CallExpression' && ['fetch', 'responseJson'].includes(node.callee.name)) {
                    found ||= /\/(?:parcels\/under|road-parcels|parcel-sources)\b/.test(urlText(node.arguments[0], bindings));
                }
                for (const value of Object.values(node)) {
                    if (Array.isArray(value)) value.forEach(child => walkAst(child, bindings));
                    else if (value && typeof value === 'object') walkAst(value, bindings);
                }
            };
            walkAst(parse(source, { sourceType: 'script' }));
            return found;
        };
        const transportFiles = files.filter(path => targetsParcels(read(path))).map(rel);
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
