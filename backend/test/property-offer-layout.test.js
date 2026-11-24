// Pins the checked-in property-offer IDL and every published devnet address mirror to its source.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUR_PROGRAMS } from '../solana/address-book.js';
import { PROOF_PROGRAMS } from '../hackathon/program-evidence.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const solana = path.resolve(here, '../../blockchain/solana');
const source = readFileSync(path.join(solana, 'programs/property_offer/src/lib.rs'), 'utf8');
const idl = JSON.parse(readFileSync(path.join(solana, 'idl/property_offer.json'), 'utf8'));
const addresses = JSON.parse(readFileSync(path.resolve(here, '../../frontend/contracts/addresses.json'), 'utf8'));

const discriminator = (prefix, name) => Array.from(createHash('sha256').update(`${prefix}:${name}`).digest().subarray(0, 8));

describe('property_offer source/IDL registration', () => {
    it('keeps the declared program ID in the devnet config, public address books and proof registry', () => {
        const declared = source.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/)[1];
        const toml = readFileSync(path.join(solana, 'Anchor.toml'), 'utf8');

        expect(idl.address).toBe(declared);
        expect([...toml.matchAll(/property_offer = "([^"]+)"/g)].map(match => match[1])).toEqual([declared, declared]);
        expect(addresses.solana.PropertyOffer).toBe(declared);
        expect(addresses['solana-devnet'].PropertyOffer).toBe(declared);
        expect(OUR_PROGRAMS).toContainEqual({ address: declared, name: 'property_offer', label: 'property_offer program' });
        expect(PROOF_PROGRAMS).toContainEqual({ address: declared, name: 'PropertyOffer' });
    });

    it('registers the generated IDL instruction surface', () => {
        expect(idl.instructions.map(instruction => instruction.name).sort()).toEqual(['accept', 'cancel', 'create', 'execute', 'expire', 'fund']);
        for (const instruction of idl.instructions) expect(instruction.discriminator).toEqual(discriminator('global', instruction.name));
    });
});
