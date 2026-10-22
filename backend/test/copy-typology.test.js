// The typology a fork of a building design opens its editor with (frontend/js/proposals/copy.js
// typologyForCopy): the record's own typology, also when the design came back from the index, where
// the design/v1 object carries it in the building payload only.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const DesignRecord = require('../../frontend/js/design-record.js');
const DesignSync = require('../../frontend/js/proposals/design-sync.js');
const Cid = require('../../frontend/js/cid.js');

const source = readFileSync(new URL('../../frontend/js/proposals/copy.js', import.meta.url), 'utf8');
const declaration = parse(source, { sourceType: 'script' }).program.body
    .find(node => node.type === 'FunctionDeclaration' && node.id?.name === 'typologyForCopy');
const context = vm.createContext({});
vm.runInContext(source.slice(declaration.start, declaration.end), context);
const typologyForCopy = context.typologyForCopy;

const site = { type: 'Polygon', coordinates: [[[15.96, 45.8], [15.961, 45.8], [15.961, 45.801], [15.96, 45.801], [15.96, 45.8]]] };
const rowDesign = () => ({
    proposalId: 'row-1', goal: 'buildings', primaryType: 'Urban Rule', typologyType: 'row', title: 'Row houses', site,
    createdAt: '2026-10-21T10:00:00.000Z', buildingProposal: { typologyType: 'row', parameters: { typology: 'row' } }
});

describe('typologyForCopy', () => {
    it('opens a fork with the typology its source was drawn with', () => {
        expect(typologyForCopy(rowDesign(), 'buildings')).toBe('row');
        expect(typologyForCopy({ ...rowDesign(), typologyType: 'parcelBased' }, 'buildings')).toBe('parcelBased');
        expect(typologyForCopy({ ...rowDesign(), typologyType: 'tower', buildingProposal: {} }, 'buildings')).toBe('block');
        expect(typologyForCopy({}, 'buildings')).toBe('block');
        expect(typologyForCopy(rowDesign(), 'row')).toBe('row');
        expect(typologyForCopy(rowDesign(), 'park')).toBeNull();
    });

    it('keeps the typology of a design read back from the index', () => {
        const content = DesignRecord.published(rowDesign());
        expect(content).not.toHaveProperty('typologyType');
        const imported = DesignSync.localDesignFromRow({ cid: Cid.cidOfObject(content), content, createdAt: '2026-10-21T12:00:00.000Z' },
            { apiBase: 'https://api.example.test' });
        expect(imported.typologyType).toBeUndefined();
        expect(typologyForCopy(imported, 'buildings')).toBe('row');
    });
});
