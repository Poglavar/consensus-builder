// Per-person positions derived from an agreement and an ownership rights snapshot. The agreement
// allocation terms name no people: each input parcel i is one allocation party P_i, "Owner(s) of parcel i"
// (agreement-record.js). With rights giving person k the share s[k][i] of parcel i (shares of a
// complete parcel sum to 1), person k co-owns every output allocated to P_i at s[k][i] and receives
// s[k][i] of P_i's cash, rounded to whole cents per parcel by the largest remainder so each parcel's
// total stays exact. Totals by person therefore equal totals by party. Pure and DOM-free.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgreementPersons = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const record = () => root.AgreementRecord
        || (typeof require === 'function' ? require('./agreement-record.js') : null);
    const approval = () => root.ProposalApproval
        || (typeof require === 'function' ? require('./proposals/approval.js') : null);

    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const listOf = value => (Array.isArray(value) ? value : []);
    const areaOf = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
    const shareOf = text => {
        const [n, d] = text.split('/').map(BigInt);
        return { n, d };
    };

    // Splits integer cents over exact shares summing to 1: each takes the floor of its exact amount,
    // and the cents left over go one each to the largest remainders (ties by owner id). Signed amounts
    // split their magnitude, so a parcel that pays splits what it pays the same way.
    function splitCents(cents, owners) {
        if (!Number.isSafeInteger(cents)) throw new TypeError('splitCents needs whole cents.');
        const sign = cents < 0 ? -1n : 1n;
        const total = BigInt(Math.abs(cents));
        const rows = owners.map(owner => {
            const { n, d } = shareOf(owner.share);
            return { ownerId: owner.ownerId, d, floor: total * n / d, remainder: total * n % d };
        });
        let left = total - rows.reduce((sum, row) => sum + row.floor, 0n);
        // remainder/d compared exactly across different denominators.
        const order = [...rows].sort((a, b) => {
            const diff = b.remainder * a.d - a.remainder * b.d;
            return diff > 0n ? 1 : diff < 0n ? -1 : compare(a.ownerId, b.ownerId);
        });
        for (const row of order) {
            if (left <= 0n) break;
            row.floor += 1n;
            left -= 1n;
        }
        return new Map(rows.map(row => [row.ownerId, Number(sign * row.floor)]));
    }

    // A parcel whose owners the snapshot states completely, by people rather than its abstract party.
    function resolvedOwners(row, prefix) {
        if (!row || row.complete !== true || !row.owners.length) return null;
        return row.owners.some(owner => owner.ownerId.startsWith(prefix)) ? null : row.owners;
    }

    /**
     * What each person holds of an agreement's parties under a rights snapshot.
     * @param agreement an agreement record or its published agreement/v1 object (inputs, outputs,
     *   allocations, money); judged elsewhere (AgreementRecord.validate), only read here
     * @param rights parcel-rights/v1 or v2 (only ownership counts; leases are not land allocations)
     * @returns {{ persons: { personId, parcels: { parcelId, share, contributedM2 }[], contributedM2,
     *     outputs: { output, pieceId, parcelId, share, areaM2 }[], landM2, cashCents }[],
     *   unresolved: { ownerKey, parcelId }[], resolved: boolean,
     *   totals: { partyLandM2, personLandM2, partyCashCents, personCashCents, balanced } }}
     *   `share` is the exact fraction; areas are m² (null when the input area is unknown). Parcels
     *   without complete rights keep their abstract party in `unresolved` and are left out of totals.
     */
    function personPositions(agreement, rights) {
        const api = record();
        const snapshot = rights ? approval().normalizeRights(rights) : null;
        const rowOf = new Map((snapshot ? snapshot.parcels : []).map(row => [row.parcelId, row]));
        const persons = new Map();
        const person = personId => {
            if (!persons.has(personId)) persons.set(personId, { personId, parcels: [], contributedM2: 0, outputs: [], landM2: 0, cashCents: 0, areaUnknown: false });
            return persons.get(personId);
        };
        const owned = new Map();
        const unresolved = [];
        listOf(agreement?.inputs?.parcels).forEach(parcel => {
            const parcelId = String(parcel.parcelId);
            const owners = resolvedOwners(rowOf.get(parcelId), api.PARTY_PREFIX);
            if (!owners) { unresolved.push({ ownerKey: api.partyKey(parcelId), parcelId }); return; }
            owned.set(api.partyKey(parcelId), { parcelId, owners });
            const parcelM2 = areaOf(parcel.areaM2);
            owners.forEach(owner => {
                const { n, d } = shareOf(owner.share);
                const entry = person(owner.ownerId);
                const contributedM2 = parcelM2 === null ? null : parcelM2 * Number(n) / Number(d);
                entry.parcels.push({ parcelId, share: owner.share, contributedM2 });
                if (contributedM2 === null) entry.areaUnknown = true; else entry.contributedM2 += contributedM2;
            });
        });
        let partyLandM2 = 0, partyCashCents = 0;
        const outputs = new Map(listOf(agreement?.outputs).map(output => [output.hash, output]));
        listOf(agreement?.allocations).forEach(({ output: hash, to }) => {
            const party = to?.kind === 'party' ? owned.get(to.ownerKey) : null;
            const output = outputs.get(hash);
            if (!party || !output) return;
            if (areaOf(output.areaM2) === null) throw new TypeError(`Output ${hash} has no area.`);
            partyLandM2 += output.areaM2;
            party.owners.forEach(owner => {
                const { n, d } = shareOf(owner.share);
                const areaM2 = output.areaM2 * Number(n) / Number(d);
                const entry = person(owner.ownerId);
                entry.outputs.push({ output: hash, pieceId: output.pieceId ?? null, parcelId: party.parcelId, share: owner.share, areaM2 });
                entry.landM2 += areaM2;
            });
        });
        listOf(agreement?.money?.lines).forEach(line => {
            const party = owned.get(line.ownerKey);
            if (!party) return;
            partyCashCents += line.amountCents;
            splitCents(line.amountCents, party.owners).forEach((cents, personId) => { person(personId).cashCents += cents; });
        });
        const list = [...persons.values()].map(({ areaUnknown, ...entry }) => ({ ...entry, contributedM2: areaUnknown ? null : entry.contributedM2 }))
            .sort((a, b) => compare(a.personId, b.personId));
        const personLandM2 = list.reduce((sum, entry) => sum + entry.landM2, 0);
        const personCashCents = list.reduce((sum, entry) => sum + entry.cashCents, 0);
        return {
            persons: list,
            unresolved,
            resolved: !unresolved.length,
            totals: { partyLandM2, personLandM2, partyCashCents, personCashCents,
                balanced: personCashCents === partyCashCents && Math.abs(personLandM2 - partyLandM2) <= Math.max(1e-6, partyLandM2 * 1e-9) }
        };
    }

    return { personPositions, splitCents };
});
