// Tests for backend/scripts/publish-restatement-archives.mjs: every committed Pionir/Paron and Nova naselja
// archive becomes a design/v1 object, dated by its archive, in its project's plan order (one plan and one
// agreement per project), and the script's command line runs the shared steps over them (dry runs only).
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { designFromArchive, projectPlan } from '../scripts/publish-restatement-archives.mjs';
import { MAX_AGREEMENT_DESIGNS, planObjects } from '../scripts/lib/restatement-publish.mjs';
import { MAX_PINNED_OBJECT_BYTES } from '../storage/pinning.js';

const BACKEND = fileURLToPath(new URL('..', import.meta.url));
const RESTATEMENTS = fileURLToPath(new URL('../../restatements/', import.meta.url));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'restatement-archives-'));
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

// The committed projects and their archives in plan order, read from the manifests themselves.
const PROJECTS = ['pionir-paron', 'nova-naselja'].flatMap(collection => fs.readdirSync(path.join(RESTATEMENTS, collection))
    .filter(project => fs.existsSync(path.join(RESTATEMENTS, collection, project, 'plan.json')))
    .sort()
    .map(project => {
        const manifest = readJson(path.join(RESTATEMENTS, collection, project, 'plan.json'));
        const files = collection === 'pionir-paron'
            ? [...(manifest.circulation || []).map(entry => entry.file), manifest.building.file]
            : manifest.proposals.map(entry => entry.file);
        return { collection, project, manifest, files, dir: path.join(RESTATEMENTS, collection, project) };
    }));

const DECLARATIONS = ['cadastreParcelIds', 'parentParcelIds', 'parentParcelNumbers', 'ancestorKey', 'parcelIds'];

describe('projectPlan', () => {
    it('finds the twelve Pionir/Paron projects and the three Nova naselja neighbourhoods', () => {
        expect(PROJECTS.filter(entry => entry.collection === 'pionir-paron')).toHaveLength(12);
        expect(PROJECTS.filter(entry => entry.collection === 'nova-naselja').map(entry => entry.project)).toEqual(['novi-jelkovec', 'podbrezje', 'vrbani-iii']);
    });

    it.each(PROJECTS.map(entry => [`${entry.collection}/${entry.project}`, entry]))('%s: its archives become valid design objects in plan order', (key, entry) => {
        const plan = projectPlan(entry.collection, entry.project);
        expect(plan).toMatchObject({ key, title: entry.manifest.title, city: 'zagreb', parcelSourceId: null, groundFile: path.join(entry.dir, 'ground.json') });
        expect(plan.designs.map(design => design.key)).toEqual(entry.files.map(file => file.replace(/\.geojson$/, '')));
        // Pionir/Paron: the circulation first, the buildings stand on the ground it leaves.
        if (entry.collection === 'pionir-paron') expect(plan.designs.at(-1).record.goal).toBe('single');
        const objects = planObjects(plan);
        expect(objects.length).toBeLessThanOrEqual(MAX_AGREEMENT_DESIGNS);
        expect(new Set(objects.map(object => object.cid)).size).toBe(objects.length);
        objects.forEach((object, index) => {
            const archive = readJson(path.join(entry.dir, entry.files[index]));
            // Dated by the archive, never by the time of publishing: the same archive is the same CID.
            expect(object.content.authoredAt).toBe(archive.reconstruction.proposal.createdAt);
            expect(object.content.author).toBe(plan.author);
            expect(object.bytes).toBeLessThanOrEqual(MAX_PINNED_OBJECT_BYTES);
            const text = JSON.stringify(object.content);
            expect(text).not.toContain('"floorPlans"');
            expect(text).not.toContain('"floorModel"');
            // No cadastre declaration on the design or its payload: the index derives what a design takes.
            DECLARATIONS.forEach(field => {
                expect(object.content, field).not.toHaveProperty(field);
                ['buildingProposal', 'roadProposal', 'structureProposal']
                    .filter(key => object.content[key])
                    .forEach(key => expect(object.content[key], `${key}.${field}`).not.toHaveProperty(field));
            });
        });
        expect(planObjects(projectPlan(entry.collection, entry.project)).map(object => object.cid)).toEqual(objects.map(object => object.cid));
    });
});

describe('designFromArchive', () => {
    const archiveOf = relative => readJson(path.join(RESTATEMENTS, relative));

    it('publishes a street with its land as its own geometry', () => {
        const record = designFromArchive(archiveOf('pionir-paron/spansko-c-d/circulation-access-921522149.geojson'), 'street');
        expect(record.goal).toBe('road-track');
        expect(record.geometry).toEqual(record.roadProposal.definition.polygon);
        expect(['Polygon', 'MultiPolygon']).toContain(record.geometry.type);
        expect(record).not.toHaveProperty('buildingProposal');
        expect(record).not.toHaveProperty('structureProposal');
    });

    it('publishes a park or square on its own footprint', () => {
        const record = designFromArchive(archiveOf('nova-naselja/podbrezje/proposal-park-z1-538.geojson'), 'park');
        expect(record.goal).toBe('park');
        expect(record.geometry).toEqual(record.structureProposal.geometry);
        expect(record.createdAt).toBe('2026-08-14T00:01:00.000Z');
    });

    it('keeps the buildings and their site but never the floor models the registry joins on', () => {
        const archive = archiveOf('pionir-paron/savica-f1-f3/proposal.geojson');
        const archived = archive.features.filter(feature => feature.properties?.['consensus:role'] === 'building');
        expect(archived.some(feature => feature.properties.floorPlans)).toBe(true);
        const record = designFromArchive(archive, 'savica');
        expect(record.geometry.buildings).toHaveLength(archived.length);
        expect(record.geometry.superParcel.geometry.type).toMatch(/Polygon/);
        record.geometry.buildings.forEach((building, index) => {
            expect(building.properties).not.toHaveProperty('floorPlans');
            expect(building.properties).not.toHaveProperty('floorModel');
            expect(building.geometry).toEqual(archived[index].geometry);
        });
        expect(record.geometry.buildings.find((_, index) => archived[index].properties.floorPlans).properties.floors)
            .toBe(archived.find(feature => feature.properties.floorPlans).properties.floors);
        // The archive is left as it was.
        expect(archived.some(feature => feature.properties.floorPlans)).toBe(true);
    });

    it('refuses a file that is not a canonical reconstruction archive', () => {
        expect(() => designFromArchive({ type: 'FeatureCollection', features: [], reconstruction: { schema: 'something-else.v1' } }, 'odd.geojson'))
            .toThrow('odd.geojson: not a canonical reconstruction archive (something-else.v1)');
        expect(() => designFromArchive({ type: 'FeatureCollection', features: [] }, 'plain.geojson')).toThrow('plain.geojson: not a canonical reconstruction archive (undefined)');
    });
});

describe('the command line (dry runs only)', () => {
    const run = args => spawnSync(process.execPath, ['scripts/publish-restatement-archives.mjs', ...args], {
        cwd: BACKEND, encoding: 'utf8', timeout: 120_000, env: { ...process.env, HOME }
    });

    it('lists every project as a plan key in its usage', () => {
        const result = run(['--help']);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Publishes the canonical restatement archives (one agreement per project) as designs plus one agreement per plan');
        expect(result.stdout).toContain('--collection <value>');
        PROJECTS.forEach(entry => expect(result.stdout).toContain(`${entry.collection}/${entry.project}`));
    }, 120_000);

    it('builds one collection\'s designs without the network and says each plan still needs its ground', () => {
        const result = run(['--dry-run', '--collection', 'nova-naselja']);
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        const neighbourhoods = PROJECTS.filter(entry => entry.collection === 'nova-naselja');
        neighbourhoods.forEach((entry, index) => {
            expect(result.stdout).toContain(`plan ${index + 1}/3 nova-naselja/${entry.project} "${entry.manifest.title}": ${entry.files.length} designs\n`);
            expect(result.stdout).toContain(`nova-naselja/${entry.project} ${entry.files.length}/${entry.files.length} single bafkrei`);
            expect(result.stdout).toContain(`nova-naselja/${entry.project}: no ground file yet`);
        });
        expect(result.stdout).not.toContain('pionir-paron/');
        expect(result.stdout).toContain('done: dry-run for 3 plan(s)');
        // A dry run writes no checkpoint.
        expect(fs.existsSync(path.join(HOME, '.config'))).toBe(false);
    }, 120_000);

    it('runs only the projects named by --only', () => {
        const result = run(['--dry-run', '--only', 'pionir-paron/savica-f1-f3']);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('plan 1/1 pionir-paron/savica-f1-f3');
        expect(result.stdout).toContain('pionir-paron/savica-f1-f3 1/2 road-track bafkrei');
        expect(result.stdout).toContain('pionir-paron/savica-f1-f3 2/2 single bafkrei');
        expect(result.stdout).toContain('done: dry-run for 1 plan(s)');
    }, 120_000);

    it('refuses an unknown collection', () => {
        const result = run(['--dry-run', '--collection', 'elsewhere']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('--collection is pionir-paron or nova-naselja, not elsewhere');
        expect(result.stdout).not.toContain('bafkrei');
    }, 120_000);
});
