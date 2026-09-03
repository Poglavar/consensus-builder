import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const frontendJsRoot = fileURLToPath(new URL('../../frontend/js', import.meta.url));
const walk = directory => readdirSync(directory).flatMap(name => {
    const absolute = join(directory, name);
    return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
});
const sourceFiles = walk(frontendJsRoot).filter(path => path.endsWith('.js'));

describe('parcel identity opacity boundary', () => {
    const generatedIdParser = /\.(?:split|includes|indexOf|lastIndexOf)\s*\(\s*['"]#['"]\s*\)/;
    const retiredParserNames = /\b(?:isPieceId|_stripSyntheticSuffix|_extractRootParcel(?:Id|Number)|_deriveRootParcel(?:Id|Number)FromParcelId|structureProposalsCoveringFeature|roadProposalsCoveringFeature|resolveParentsByGeometry|loadedLiveParcels|__activeParcelFabricDomainTransaction|_activeFabricTransaction)\b/;

    it.each(sourceFiles)('%s never infers parcel meaning from a generated-id delimiter', absolutePath => {
        const source = readFileSync(absolutePath, 'utf8');
        expect(source, relative(frontendJsRoot, absolutePath)).not.toMatch(generatedIdParser);
        expect(source, relative(frontendJsRoot, absolutePath)).not.toMatch(retiredParserNames);
    });

    it('keeps cadastral import as an explicitly declared repository boundary', () => {
        const source = readFileSync(join(frontendJsRoot, 'parcels/ingest.js'), 'utf8');
        expect(source).toContain('async function ingestCadastralParcelFeatures');
        expect(source).toContain('CadastralParcelRepository');
        expect(source).toContain('.acceptFeatures(');
        expect(source).not.toContain('ingestParcelFeatures');
        expect(source).not.toContain('LiveParcelFabric');
        expect(source).not.toContain('seedCadastre');
        expect(source).not.toContain('upsertFeatures');
    });

    it('uses explicit provenance when identifying revision-local corridor arrangement', () => {
        const source = readFileSync(join(frontendJsRoot, 'proposals/parcel-arrangement.js'), 'utf8');
        expect(source).toContain("LIVE_DERIVATION = 'corridor-arrangement'");
        expect(source).toContain('props.liveParcelDerivation === LIVE_DERIVATION');
        expect(source).not.toMatch(generatedIdParser);
    });

    it('keeps identity readers pure and identity writers explicit', () => {
        const generic = readFileSync(join(frontendJsRoot, 'parcels/parcel-id.js'), 'utf8');
        const proposal = readFileSync(join(frontendJsRoot, 'proposals/parcel-id.js'), 'utf8');
        const formation = readFileSync(join(frontendJsRoot, 'proposal-parcel-identity.js'), 'utf8');
        const getBody = generic.slice(generic.indexOf('function getParcelId('), generic.indexOf('global.ensureParcelId'));
        expect(getBody).not.toContain('ensureParcelId(');
        expect(proposal.slice(0, proposal.indexOf('function ensureParcelIdOnFeature'))).not.toContain('ensureParcelId(');
        expect(formation.slice(formation.indexOf('function _getParcelIdFromProperties'), formation.indexOf('function _ensureParcelIdOnProperties')))
            .not.toContain('ensureParcelId(');
    });

    it('materializes corridors only over their published cadastral declarations', () => {
        const source = readFileSync(join(frontendJsRoot, 'proposal-manager.js'), 'utf8');
        const start = source.indexOf('async _deriveCorridorFabricBody(options = {})');
        const body = source.slice(start, source.indexOf('\n    },', start));
        expect(body).toContain('take.cadastreParcelIds');
        expect(body).toContain('repository.getMany(scope)');
        expect(body).toContain('takesByCadastreId.get(id)');
        expect(body).not.toContain('loadedCadastreParcels');
        expect(body).not.toContain('repository.list(');
    });
});
