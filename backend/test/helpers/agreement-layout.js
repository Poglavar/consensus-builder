// The agreement program's Agreement account as its Rust source declares it
// (blockchain/solana/programs/agreement/src/lib.rs): the struct's fields in order, their borsh byte
// offsets after the 8-byte discriminator, the constants agreement::read_agreement_view reads with, the
// status codes and the program id. The proposal_market and proposal_pledge layout tests pin those
// programs' reads, the IDL, the JS codec and the test encoder to it, so a field moved in one place and
// not the others fails.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOLANA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../blockchain/solana');
export const readSolana = relative => readFileSync(path.join(SOLANA_DIR, relative), 'utf8');

// `pub name: Type,` lines of one struct body, in order (attributes and doc comments skipped).
export function rustStructFields(source, header) {
    const start = source.indexOf(header);
    if (start < 0) throw new Error(`struct header not found: ${header}`);
    const body = source.slice(start + header.length, source.indexOf('\n}', start));
    return body.split('\n').map(line => line.trim()).filter(line => line.startsWith('pub ')).map(line => {
        const match = line.match(/^pub (\w+): (.+?),?$/);
        if (!match) throw new Error(`unparsed field line: ${line}`);
        return { name: match[1], type: match[2].trim() };
    });
}

// The `Name = n` variants of a unit enum, as { Name: n }.
export function rustEnumCodes(source, name) {
    const start = source.indexOf(`pub enum ${name} {`);
    if (start < 0) throw new Error(`enum not found: ${name}`);
    const body = source.slice(start, source.indexOf('}', start));
    return Object.fromEntries([...body.matchAll(/(\w+) = (\d+)/g)].map(match => [match[1], Number(match[2])]));
}

// The value of `pub const NAME: usize = <sums of products of integers>;`, computed without eval.
export function rustUsizeConst(source, name) {
    const match = source.match(new RegExp(`pub const ${name}: usize = ([0-9 +*]+);`));
    if (!match) throw new Error(`usize const not found: ${name}`);
    return match[1].split('+').reduce((sum, term) => sum + term.split('*').reduce((product, factor) => product * Number(factor.trim()), 1), 0);
}

// The body of one Rust fn, from `fn name(` to the closing brace at the start of a line.
export function rustFnBody(source, name) {
    const start = source.indexOf(`fn ${name}(`);
    if (start < 0) throw new Error(`fn not found: ${name}`);
    return source.slice(start, source.indexOf('\n}', start) + 2);
}

// Borsh size of a fixed-size field; null for the trailing String, whose length varies.
function fieldSize(type, unitEnums) {
    if (type === 'Pubkey') return 32;
    if (type === 'i64' || type === 'u64') return 8;
    if (type === 'bool' || type === 'u8' || unitEnums.includes(type)) return 1;
    const array = type.match(/^\[u8; (\d+)\]$/);
    if (array) return Number(array[1]);
    if (type === 'String') return null;
    throw new Error(`no borsh size for ${type}`);
}

/** The Agreement account per the agreement program's source. */
export function agreementRustLayout() {
    const source = readSolana('programs/agreement/src/lib.rs');
    const fields = rustStructFields(source, 'pub struct Agreement {');
    // Unit enums are one borsh byte (their variant index).
    const unitEnums = ['AgreementStatus', 'Decision'];
    const offsets = {};
    let offset = 8;
    for (const field of fields) {
        offsets[field.name] = offset;
        const size = fieldSize(field.type, unitEnums);
        if (size === null) break;
        offset += size;
    }
    return {
        source,
        fields,
        offsets,
        LENS_OFFSET: rustUsizeConst(source, 'LENS_OFFSET'),
        STATUS_OFFSET: rustUsizeConst(source, 'STATUS_OFFSET'),
        statusCodes: rustEnumCodes(source, 'AgreementStatus'),
        decisionCodes: rustEnumCodes(source, 'Decision'),
        programId: source.match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/)[1]
    };
}
