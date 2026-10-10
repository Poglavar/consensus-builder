#!/usr/bin/env node
// Name the two Borovje plans (plans.md) on a backend: the official reconstruction and the "urbani
// blokovi" alternative. Both share the official parcel layouts, streets and parks; they differ in
// their eleven buildings. Members are resolved by stable proposal_id, so the same script names the
// same plans (with the same plan hash) on any backend that holds the records. Named plans never
// change: a name that exists is reported and left alone. The -v2 plans supersede the first two: their
// outer boundary follows the cadastre and the collector runs down the middle of its band
// (snap-to-cadastre.mjs); members that correction changed are its `-v2` records. The -v3 plans supersede
// those: every street takes exactly the ground its lanes cut (fit-streets.mjs).
//
//   node name-plans.mjs --backend <api> --origin <app origin>           # dry run: resolve and print
//   node name-plans.mjs --backend <api> --origin <app origin> --apply
import { parseArgs } from 'node:util';
import { request } from '../../backend/scripts/lib/candlestick-common.mjs';

const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const KAZETE = Array.from({ length: 11 }, (_, i) => `m1-${i + 1}`);
// Apply order: parcel layouts, the second street piece, buildings, parks, then the main street —
// the order the verified 22/22 link uses (README.md).
const shared = {
    head: ['p-upu-borovje-parcelacija', 'p-upu-borovje-parcelacija-2', 'p-upu-borovje-parcelacija-3', 'upu-borovje-ulice-split-1'],
    tail: ['upu-borovje-r2-0', 'upu-borovje-z1-1', 'upu-borovje-z1-2', 'upu-borovje-z1-3', 'upu-borovje-z1-4', 'upu-borovje-z1-5', 'upu-borovje-ulice']
};
export const PLANS = [
    {
        slug: 'upu-borovje',
        title: 'UPU Borovje – zona jug (prijedlog plana 2026)',
        author: 'Grad Zagreb (rekonstrukcija prijedloga plana)',
        description: 'Rekonstrukcija prijedloga Urbanističkog plana uređenja Borovje – zona jug (javna rasprava 23.6.–22.7.2026): '
            + 'jedanaest samostojećih lamela P+3 do P+8 na građevnim česticama M1-1…M1-11, javni parkovi Z1, rekreacija R2, '
            + 'nova ulična mreža i parcelacija.',
        members: [...shared.head, ...KAZETE.map(k => `upu-borovje-${k}`), ...shared.tail]
    },
    {
        slug: 'borovje-urbani-blokovi',
        title: 'Borovje – urbani blokovi (alternativa)',
        author: 'Urban Game Theory – alternativni prijedlog',
        description: 'Alternativa planu UPU Borovje na istim građevnim česticama: otvoreni gradski blokovi P+4 i P+5 koji drže '
            + 'ulicu, s dvorištima otvorenima prema parku, umjesto samostojećih lamela. Ulice, parcelacija i parkovi isti su kao '
            + 'u službenom planu.',
        members: [...shared.head, ...KAZETE.map(k => `borovje-urbani-blokovi-${k}`), ...shared.tail]
    }
];
// Version 2: the same plans on the cadastral boundary. A member the correction changed is its -v2 record.
const REVISED = new Set(['p-upu-borovje-parcelacija', 'p-upu-borovje-parcelacija-2', 'p-upu-borovje-parcelacija-3',
    'upu-borovje-ulice', 'upu-borovje-ulice-split-1', 'upu-borovje-z1-1', 'upu-borovje-z1-5',
    'borovje-urbani-blokovi-m1-1', 'borovje-urbani-blokovi-m1-2', 'borovje-urbani-blokovi-m1-10', 'borovje-urbani-blokovi-m1-11']);
const V2_NOTE = ' Verzija 2: vanjska granica slijedi katastarske čestice (prva rekonstrukcija zahvaćala je rubove susjednih '
    + 'čestica, ponajviše vrtova južno od sabirne ulice), a sabirna ulica položena je u sredinu svog pojasa, kao na kartografskom prikazu 2a.';
// Version 3: every street takes exactly the ground its lanes cut (fit-streets.mjs). Each member is its newest
// record up to -v3 (the v3 correction, else the v2 one, else the original), resolved when the plan is named.
const V3_NOTE = ' Verzija 3: svaka ulica zauzima točno zemljište koje zauzimaju njezine trake; čestice uz ulicu protežu se '
    + 'do nje, a pojas između sabirne ulice i susjednih vrtova ostaje gradskoj čestici.';
for (const plan of PLANS.slice(0, 2)) {
    PLANS.push({ ...plan, slug: `${plan.slug}-v2`, supersedes: plan.slug, description: plan.description + V2_NOTE,
        members: plan.members.map(id => (REVISED.has(id) ? `${id}-v2` : id)) });
}
for (const plan of PLANS.slice(0, 2)) {
    PLANS.push({ ...plan, slug: `${plan.slug}-v3`, supersedes: `${plan.slug}-v2`, description: plan.description + V3_NOTE,
        newestUpTo: 3 });
}

const { values } = parseArgs({ options: {
    backend: { type: 'string' }, origin: { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' }
} });
if (values.help || !values.backend || !values.origin) {
    console.log('Usage: node name-plans.mjs --backend <api> --origin <app origin> [--apply]');
    process.exit(values.help ? 0 : 1);
}

for (const plan of PLANS) {
    const existing = await request(values.backend, values.origin, 'GET', `/plans/${plan.slug}`);
    if (existing.status === 200) {
        log(`${plan.slug} already named (${existing.json.proposalIds.length} members, hash ${existing.json.planHash}); left alone`);
        continue;
    }
    const ids = [];
    const chosen = [];
    for (const proposalId of plan.members) {
        const candidates = plan.newestUpTo
            ? Array.from({ length: plan.newestUpTo - 1 }, (_, i) => `${proposalId}-v${plan.newestUpTo - i}`).concat(proposalId)
            : [proposalId];
        let found = null;
        for (const candidate of candidates) {
            const response = await request(values.backend, values.origin, 'GET', `/proposals/${encodeURIComponent(candidate)}`);
            const id = response.json && (response.json.id ?? response.json.proposal?.id);
            if (response.status === 200 && id) { found = { candidate, id }; break; }
        }
        if (!found) throw new Error(`${values.backend} has no ${candidates.join(' / ')}`);
        ids.push(String(found.id));
        chosen.push(found.candidate);
    }
    if (plan.newestUpTo) log(`${plan.slug} members: ${chosen.join(', ')}`);
    log(`${plan.slug}: ${ids.length} members → ${ids.join(',')}`);
    if (!values.apply) continue;
    const created = await request(values.backend, values.origin, 'POST', '/plans', {
        slug: plan.slug, proposalIds: ids, title: plan.title, description: plan.description, author: plan.author,
        place: 'Borovje', city: 'zagreb', ...(plan.supersedes ? { supersedes: plan.supersedes } : {})
    });
    if (created.status !== 201) throw new Error(`naming ${plan.slug} failed (${created.status}): ${created.text.slice(0, 300)}`);
    log(`named ${plan.slug} · hash ${created.json.planHash} · mintable ${created.json.mintable}`);
}
if (!values.apply) log('DRY RUN: nothing named (add --apply).');
