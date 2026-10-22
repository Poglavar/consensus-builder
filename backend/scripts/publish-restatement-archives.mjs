#!/usr/bin/env node
// Publishes the canonical restatement archives of restatements/pionir-paron and restatements/nova-naselja
// as designs plus one agreement per project, through lib/restatement-publish.mjs. Each project's plan.json
// manifest names its archives in plan order (Pionir/Paron: circulation first, then the buildings, so they
// stand on the ground the roads leave; Nova naselja: roads, parks and squares, then buildings) and gives
// the agreement its title; the archive codecs (proposals/reconstruction-geojson.js,
// corridor-reconstruction-geojson.js, structure-reconstruction-geojson.js) read them. The archives are
// written by the seed-*.mjs exporters; this script reads only committed files until a step needs the API.
//
//   node scripts/publish-restatement-archives.mjs --dry-run [--collection pionir-paron|nova-naselja]
//   node scripts/publish-restatement-archives.mjs --designs --api <api> [--origin <app>] --apply
//   node scripts/publish-restatement-archives.mjs --capture --app <app> --api <api> [--only <collection>/<project>,…]
//   node scripts/publish-restatement-archives.mjs --agreement --api <api> [--origin <app>] [--app <app>] --apply

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECONSTRUCTION_GEOJSON_SCHEMA, reconstructionGeoJSONToProposal } from '../proposals/reconstruction-geojson.js';
import { CORRIDOR_RECONSTRUCTION_GEOJSON_SCHEMA, corridorReconstructionGeoJSONToProposal } from '../proposals/corridor-reconstruction-geojson.js';
import { STRUCTURE_RECONSTRUCTION_GEOJSON_SCHEMA, structureReconstructionGeoJSONToProposal } from '../proposals/structure-reconstruction-geojson.js';
import { runRestatementCli } from './lib/restatement-publish.mjs';

const RESTATEMENTS = fileURLToPath(new URL('../../restatements/', import.meta.url));
const MANIFEST_SCHEMA = 'consensus-builder.reconstruction-plan.v1';
// The archives of a project in plan order, by its manifest.
const COLLECTIONS = Object.freeze({
    'pionir-paron': manifest => [...(manifest.circulation || []).map(entry => entry.file), manifest.building.file],
    'nova-naselja': manifest => manifest.proposals.map(entry => entry.file)
});
// Floor models are read data the floor-model registry joins onto buildings (docs/building-floor-models.md),
// never part of a published design.
const FLOOR_MODEL_PROPERTIES = Object.freeze(['floorPlans', 'floorModel']);

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function projectsOf(collection) {
    const root = path.join(RESTATEMENTS, collection);
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'plan.json')))
        .map(entry => entry.name)
        .sort();
}

const planKeys = Object.keys(COLLECTIONS).flatMap(collection => projectsOf(collection).map(project => `${collection}/${project}`));

function withoutFloorModels(feature) {
    const properties = { ...(feature.properties || {}) };
    FLOOR_MODEL_PROPERTIES.forEach(key => { delete properties[key]; });
    return { ...feature, properties };
}

/** The local design record of one canonical archive: what the archive authored, dated by the archive. */
export function designFromArchive(archive, label) {
    const schema = archive?.reconstruction?.schema;
    let proposal;
    if (schema === RECONSTRUCTION_GEOJSON_SCHEMA) proposal = reconstructionGeoJSONToProposal(archive);
    else if (schema === CORRIDOR_RECONSTRUCTION_GEOJSON_SCHEMA) ({ proposal } = corridorReconstructionGeoJSONToProposal(archive));
    else if (schema === STRUCTURE_RECONSTRUCTION_GEOJSON_SCHEMA) ({ proposal } = structureReconstructionGeoJSONToProposal(archive));
    else throw new Error(`${label}: not a canonical reconstruction archive (${schema})`);
    const base = {
        goal: proposal.goal,
        title: proposal.title,
        description: proposal.description,
        author: proposal.author,
        city: proposal.city,
        createdAt: proposal.createdAt
    };
    if (proposal.roadProposal) {
        // A street's own geometry is its land.
        return { ...base, geometry: proposal.roadProposal.definition.polygon, roadProposal: proposal.roadProposal };
    }
    if (proposal.structureProposal) {
        return { ...base, geometry: proposal.structureProposal.geometry, structureProposal: proposal.structureProposal };
    }
    return {
        ...base,
        geometry: { superParcel: proposal.geometry.superParcel, buildings: proposal.geometry.buildings.map(withoutFloorModels) },
        buildingProposal: proposal.buildingProposal
    };
}

/** One project's plan: its archives as designs in plan order and its manifest's title. */
export function projectPlan(collection, project) {
    const dir = path.join(RESTATEMENTS, collection, project);
    const manifest = readJson(path.join(dir, 'plan.json'));
    if (manifest.schema !== MANIFEST_SCHEMA || manifest.project !== project) {
        throw new Error(`${collection}/${project}/plan.json is not the ${MANIFEST_SCHEMA} manifest of ${project}`);
    }
    const designs = COLLECTIONS[collection](manifest).map(file => ({
        key: file.replace(/\.geojson$/, ''),
        record: designFromArchive(readJson(path.join(dir, file)), `${collection}/${project}/${file}`)
    }));
    const authors = [...new Set(designs.map(design => design.record.author))];
    const cities = [...new Set(designs.map(design => design.record.city))];
    if (authors.length !== 1 || cities.length !== 1) {
        throw new Error(`${collection}/${project}: its archives name ${authors.length} authors and ${cities.length} cities; one agreement needs one of each`);
    }
    return {
        key: `${collection}/${project}`,
        title: manifest.title,
        author: authors[0],
        city: cities[0],
        parcelSourceId: null,
        groundFile: path.join(dir, 'ground.json'),
        designs
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runRestatementCli({
        script: 'backend/scripts/publish-restatement-archives.mjs',
        describe: 'the canonical restatement archives (one agreement per project)',
        planKeys,
        options: { collection: { type: 'string', description: `Only one collection: ${Object.keys(COLLECTIONS).join(' or ')}.` } },
        plans: async values => {
            if (values.collection && !COLLECTIONS[values.collection]) {
                throw Object.assign(new Error(`--collection is ${Object.keys(COLLECTIONS).join(' or ')}, not ${values.collection}`), { stated: true });
            }
            return Object.keys(COLLECTIONS)
                .filter(collection => !values.collection || collection === values.collection)
                .flatMap(collection => projectsOf(collection).map(project => projectPlan(collection, project)));
        }
    });
}
