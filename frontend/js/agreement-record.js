// The agreement as a browser record (plan-design-agreement.md, M1 (b)): its canonical form, the
// content hash of an output piece, validation by dialog section, the per-party ledger, and the
// subject and default rights snapshot the approval engine counts; and its published agreement/v1
// object with that object's CID (M2).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgreementRecord = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const SCHEMA = 'agreement/v1';
    // The published object (M2) names the same schema; it is what the local record publishes as.
    const PUBLISHED_SCHEMA = 'agreement/v1';
    const OUTPUT_HASH_PREFIX = 'piece1-sha256:';
    const ROLES = ['plot', 'remainder', 'corridor', 'part', 'parcel'];
    const ELECTORATES = ['owners', 'community'];
    const BASIS_POINTS = 10000;
    const HOLDERS = Object.freeze({ kind: 'holders' });
    const sha256 = () => root.__consentSha256
        || (typeof require === 'function' ? require('../vendor/noble-hashes-1.8.0/sha256.js') : null);
    const approval = () => root.ProposalApproval
        || (typeof require === 'function' ? require('./proposals/approval.js') : null);
    const deal = () => root.ReparcellizationDeal
        || (typeof require === 'function' ? require('./reparcellization-deal.js') : null);
    const allocation = () => root.ReparcellizationAllocation
        || (typeof require === 'function' ? require('./reparcellization-allocation.js') : null);
    const cid = () => {
        const api = root.Cid || (typeof require === 'function' ? require('./cid.js') : null);
        if (!api) throw new Error('Cid (js/cid.js) is not loaded.');
        return api;
    };

    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const clone = value => JSON.parse(JSON.stringify(value));
    const textOf = value => typeof value === 'string' && value.trim() ? value.trim() : null;
    // A party key as an allocation or money line names it; '' is kept for validate to report.
    const keyOf = value => typeof value === 'string' || finite(value) ? String(value).trim() : '';

    function fail(message) {
        const error = new Error(message);
        error.code = 'invalid-agreement';
        throw error;
    }

    // An id as the record keeps it: a trimmed string (cadastral ids may arrive as numbers).
    function idOf(value, what) {
        const id = keyOf(value);
        if (!id) fail(`${what} needs an id.`);
        return id;
    }

    // JSON with object keys sorted at every depth, so equal content always gives equal text.
    // Undefined keys are left out; a number that is not finite is refused rather than written as null.
    function stableStringify(value) {
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Agreement numbers must be finite.');
        if (typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
        return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
            .map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }

    // A piece's geometry as its hash sees it: type and coordinates, each rounded to 7 decimals
    // (about a centimetre). A Feature wrapper, bbox or properties never reach the hash.
    function canonicalGeometry(value) {
        const shape = value && value.type === 'Feature' ? value.geometry : value;
        if (!shape || (shape.type !== 'Polygon' && shape.type !== 'MultiPolygon')) {
            throw new Error('An agreement output needs Polygon or MultiPolygon geometry.');
        }
        const number = n => {
            if (!finite(n)) throw new Error('An agreement output has a coordinate that is not a finite number.');
            return Number(n.toFixed(7));
        };
        const position = point => {
            if (!Array.isArray(point) || point.length < 2) throw new Error('An agreement output has an invalid position.');
            return point.map(number);
        };
        const ring = points => {
            if (!Array.isArray(points) || points.length < 4) throw new Error('An agreement output has a ring of fewer than four positions.');
            return points.map(position);
        };
        const polygon = rings => {
            if (!Array.isArray(rings) || !rings.length) throw new Error('An agreement output has an empty polygon.');
            return rings.map(ring);
        };
        if (shape.type === 'Polygon') return { type: 'Polygon', coordinates: polygon(shape.coordinates) };
        if (!Array.isArray(shape.coordinates) || !shape.coordinates.length) throw new Error('An agreement output has an empty polygon.');
        return { type: 'MultiPolygon', coordinates: shape.coordinates.map(polygon) };
    }

    // The content hash an allocation names an output piece by.
    const isOutputHash = value => typeof value === 'string' && new RegExp(`^${OUTPUT_HASH_PREFIX}[0-9a-f]{64}$`).test(value);

    function outputHash(geometry) {
        return OUTPUT_HASH_PREFIX + sha256().sha256Hex(stableStringify(canonicalGeometry(geometry)));
    }

    // A local key, stable across edits; not a content hash.
    function newId() {
        const bytes = new Uint8Array(16);
        root.crypto.getRandomValues(bytes);
        return 'ag-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    function holdersOf(list, where) {
        if (!Array.isArray(list)) fail(`${where} needs a holders list.`);
        const seen = new Set();
        return list.map(holder => {
            if (!isObject(holder)) fail(`${where} has an invalid holder.`);
            const ownerKey = idOf(holder.ownerKey, `A holder of ${where}`);
            if (seen.has(ownerKey)) fail(`${where} lists holder ${ownerKey} twice.`);
            seen.add(ownerKey);
            if (!finite(holder.share) || holder.share <= 0 || holder.share > 1) {
                fail(`The share of ${ownerKey} in ${where} must be above 0 and at most 1.`);
            }
            return { ownerKey, displayName: textOf(holder.displayName) || ownerKey, share: holder.share };
        });
    }

    function areaOf(value, what, nullable) {
        if (nullable && (value === undefined || value === null)) return null;
        if (!finite(value) || value < 0) fail(`${what} needs a finite area of at least 0${nullable ? ' or null' : ''}.`);
        return value;
    }

    function timestampOf(value, what) {
        if (value === undefined || value === null) return null;
        const ms = typeof value === 'string' ? Date.parse(value) : NaN;
        if (!Number.isFinite(ms)) fail(`${what} must be an ISO date.`);
        return new Date(ms).toISOString();
    }

    function designsOf(list) {
        if (!Array.isArray(list)) fail('The agreement needs its list of designs.');
        const seen = new Set();
        return list.map(design => {
            if (!isObject(design)) fail('A design entry is invalid.');
            const proposalId = idOf(design.proposalId, 'A design');
            if (seen.has(proposalId)) fail(`Design ${proposalId} is listed twice.`);
            seen.add(proposalId);
            return { proposalId, title: textOf(design.title), goal: textOf(design.goal), cid: textOf(design.cid) };
        });
    }

    function inputsOf(raw) {
        if (!isObject(raw) || !Array.isArray(raw.parcels)) fail('The agreement needs its input parcels.');
        const seen = new Set();
        const parcels = raw.parcels.map(parcel => {
            if (!isObject(parcel)) fail('An input parcel is invalid.');
            const parcelId = idOf(parcel.parcelId, 'An input parcel');
            if (seen.has(parcelId)) fail(`Input parcel ${parcelId} is listed twice.`);
            seen.add(parcelId);
            return {
                parcelId,
                areaM2: areaOf(parcel.areaM2, `Input parcel ${parcelId}`, true),
                holders: holdersOf(parcel.holders, `input parcel ${parcelId}`)
            };
        });
        return { parcels, openGroundM2: raw.openGroundM2 == null ? 0 : areaOf(raw.openGroundM2, 'The open ground') };
    }

    // The stored geometry is the canonical one, and the hash must be its hash: allocations name
    // outputs by hash, so two outputs with one geometry, or a hash that lies, make the record ambiguous.
    function outputsOf(list) {
        if (!Array.isArray(list)) fail('The agreement needs its outputs.');
        const seen = new Set();
        return list.map(output => {
            if (!isObject(output)) fail('An output is invalid.');
            const pieceId = idOf(output.pieceId, 'An output');
            // An agreement imported from its published object (M2) carries its outputs by hash
            // alone until the ground here re-derives them; such an output keeps geometry null.
            let geometry = null;
            let hash;
            if (output.geometry === null || output.geometry === undefined) {
                if (!isOutputHash(output.hash)) fail(`Output ${pieceId} has neither geometry nor a hash.`);
                hash = output.hash;
            } else {
                try { geometry = canonicalGeometry(output.geometry); } catch (error) { fail(`Output ${pieceId}: ${error.message}`); }
                hash = OUTPUT_HASH_PREFIX + sha256().sha256Hex(stableStringify(geometry));
                if (output.hash !== hash) fail(`Output ${pieceId} does not match its geometry.`);
            }
            if (seen.has(hash)) fail(`Output ${pieceId} has the geometry of another output.`);
            seen.add(hash);
            if (!Array.isArray(output.fromParcelIds)) fail(`Output ${pieceId} needs the parcels it stands on.`);
            if (!ROLES.includes(output.role)) fail(`Output ${pieceId} has an unknown role.`);
            return {
                hash,
                pieceId,
                areaM2: areaOf(output.areaM2, `Output ${pieceId}`),
                fromParcelIds: output.fromParcelIds.map(id => idOf(id, `A parcel under output ${pieceId}`)),
                producedBy: output.producedBy == null || output.producedBy === '' ? null : idOf(output.producedBy, `The design of output ${pieceId}`),
                role: output.role,
                holders: holdersOf(output.holders, `output ${pieceId}`),
                geometry
            };
        });
    }

    // A 'holders' line means what no line means (the carried-over holding), so it is not stored.
    // Party keys and joint shares are kept as given; validate reports unknown or invalid ones.
    function allocationsOf(list) {
        if (list === undefined || list === null) return [];
        if (!Array.isArray(list)) fail('Allocations must be a list.');
        const seen = new Set();
        return list.map(line => {
            if (!isObject(line) || !isObject(line.to)) fail('An allocation line is invalid.');
            const output = typeof line.output === 'string' ? line.output.trim() : '';
            if (!output) fail('An allocation line names no output.');
            if (seen.has(output)) fail('An output has two allocation lines.');
            seen.add(output);
            const kind = line.to.kind;
            if (kind === 'holders' || kind === 'public') return { output, to: { kind } };
            if (kind === 'party') return { output, to: { kind, ownerKey: keyOf(line.to.ownerKey) } };
            if (kind === 'joint') {
                if (!Array.isArray(line.to.shares)) fail('A joint allocation needs its shares.');
                return { output, to: { kind, shares: line.to.shares.map(row => ({ ownerKey: keyOf(row && row.ownerKey), share: row ? row.share : undefined })) } };
            }
            return fail(`Unknown allocation kind ${String(kind)}.`);
        }).filter(line => line.to.kind !== 'holders');
    }

    // A zero line is no line. Amounts and the currency are kept as given; validate reports them.
    function moneyOf(raw) {
        if (raw === undefined || raw === null) return { currency: 'EUR', lines: [] };
        if (!isObject(raw)) fail('Money must be an object.');
        if (raw.lines != null && !Array.isArray(raw.lines)) fail('Money lines must be a list.');
        const seen = new Set();
        const lines = (raw.lines || []).map(line => {
            if (!isObject(line)) fail('A money line is invalid.');
            const ownerKey = keyOf(line.ownerKey);
            if (seen.has(ownerKey)) fail(`Party ${ownerKey} has two money lines.`);
            seen.add(ownerKey);
            return { ownerKey, amountCents: line.amountCents };
        }).filter(line => line.amountCents !== 0);
        return { currency: raw.currency == null ? 'EUR' : String(raw.currency).trim().toUpperCase(), lines };
    }

    function ruleOf(raw) {
        if (!isObject(raw)) fail('The agreement needs a decision rule.');
        return {
            electorate: typeof raw.electorate === 'string' ? raw.electorate.trim() : null,
            binding: raw.binding === true,
            approvalConfig: raw.approvalConfig == null ? null : clone(raw.approvalConfig),
            lens: raw.lens == null ? [] : clone(raw.lens)
        };
    }

    // A readable deadline becomes ISO; an unreadable one is kept as typed for validate to report.
    function deadlineOf(value) {
        if (value === undefined || value === null || value === '') return null;
        const ms = typeof value === 'string' ? Date.parse(value) : NaN;
        return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
    }

    // The canonical record. Throws (code 'invalid-agreement') only when its shape is unusable:
    // wrong schema, missing ids, wrong types, duplicates that make a reference ambiguous, an output
    // hash that is not its geometry's. Everything the dialog can get wrong is left to validate.
    // Where the agreement went when it was proposed (M2): its CID, when, and the index it was sent
    // to. Absent until then; a published agreement is immutable, its CID is what decisions sign.
    function publishedOf(raw) {
        if (raw === undefined || raw === null) return null;
        if (!isObject(raw)) fail('published must be an object.');
        if (!cid().isCid(raw.cid)) fail('published.cid must be a CID.');
        const apiBase = textOf(raw.apiBase);
        if (!apiBase) fail('published.apiBase is required.');
        return { cid: raw.cid, publishedAt: timestampOf(raw.publishedAt, 'published.publishedAt'), apiBase };
    }

    function normalize(raw) {
        if (!isObject(raw) || raw.schema !== SCHEMA) fail(`Expected ${SCHEMA}.`);
        return {
            schema: SCHEMA,
            id: idOf(raw.id, 'The agreement'),
            title: textOf(raw.title),
            city: textOf(raw.city),
            createdAt: timestampOf(raw.createdAt, 'createdAt'),
            updatedAt: timestampOf(raw.updatedAt, 'updatedAt'),
            designs: designsOf(raw.designs),
            inputs: inputsOf(raw.inputs),
            outputs: outputsOf(raw.outputs),
            allocations: allocationsOf(raw.allocations),
            money: moneyOf(raw.money),
            rule: ruleOf(raw.rule),
            deadline: deadlineOf(raw.deadline),
            published: publishedOf(raw.published)
        };
    }

    // What the approval engine (proposals/approval.js inspect/tally) counts for this agreement.
    function approvalSubject(agreement) {
        return {
            cadastreParcelIds: ((agreement && agreement.inputs && agreement.inputs.parcels) || []).map(parcel => String(parcel.parcelId)),
            approvalConfig: (agreement && agreement.rule && agreement.rule.approvalConfig) || null,
            lens: (agreement && agreement.rule && agreement.rule.lens) || []
        };
    }

    // The default rights snapshot: the inputs' local holders as parcel-rights/v1, shares in basis
    // points with the last holder taking the remainder; a parcel without holders is incomplete.
    function rightsFromInputs(inputs) {
        const parcels = ((inputs && inputs.parcels) || []).map(parcel => {
            const holders = Array.isArray(parcel.holders) ? parcel.holders : [];
            let given = 0;
            const owners = holders.map((holder, index) => {
                const points = index === holders.length - 1 ? BASIS_POINTS - given : Math.round(holder.share * BASIS_POINTS);
                given += points;
                return { ownerId: String(holder.ownerKey), share: `${points}/${BASIS_POINTS}` };
            });
            // Whole square metres: the rights file is read by people, and the engine's area tests
            // need no more than that; a sub-metre parcel still counts as one.
            const areaM2 = finite(parcel.areaM2) && parcel.areaM2 > 0 ? Math.max(1, Math.round(parcel.areaM2)) : null;
            return { parcelId: String(parcel.parcelId), complete: holders.length > 0, areaM2, owners };
        });
        return { schema: approval().RIGHTS_SCHEMA, source: { provider: 'local-owners' }, parcels };
    }

    // Every party that holds land in the agreement, before or after: whom allocations and cash may name.
    function landParties(agreement) {
        return new Set([...agreement.inputs.parcels, ...agreement.outputs]
            .flatMap(row => row.holders.map(holder => holder.ownerKey)));
    }

    // Joint shares are stored as fractions; parsePercentShares checks them (positive, unique keys,
    // summing to 1) and gives the last one the exact remainder. Only its refusals become { error }.
    function jointShares(shares) {
        const parse = allocation().parsePercentShares;
        try {
            return { shares: parse(shares.map(row => ({ ownerKey: row.ownerKey, percent: finite(row.share) ? row.share * 100 : NaN }))) };
        } catch (error) {
            return { error };
        }
    }

    /**
     * Checks an agreement section by section. Throws like normalize for a malformed record.
     * @param options { designOf?(proposalId) → record | null, isApplied?(record) → boolean }: with
     *   both, every design must be present and applied (design-not-applied); without, that is skipped.
     * @returns {{ valid, errors: { code, message, section, proposalId?, output?, ownerKey? }[],
     *   warnings: { code, message, section, reason? }[] }}
     */
    function validate(raw, { designOf, isApplied } = {}) {
        const agreement = normalize(raw);
        const errors = [];
        const warnings = [];
        const add = (list, section, code, message, extra) => { list.push({ code, message, section, ...extra }); };

        if (!agreement.designs.length) add(errors, 'designs', 'no-designs', 'Choose at least one design.');
        if (typeof designOf === 'function' && typeof isApplied === 'function') {
            agreement.designs.forEach(design => {
                const found = designOf(design.proposalId);
                if (!found || !isApplied(found)) {
                    add(errors, 'designs', 'design-not-applied', `Design ${design.title || design.proposalId} is not applied on the map.`, { proposalId: design.proposalId });
                }
            });
        }

        const { parcels, openGroundM2 } = agreement.inputs;
        if (!parcels.length && !(openGroundM2 > 0)) add(errors, 'land', 'no-inputs', 'The designs take no land: apply them to the ground first.');
        if (openGroundM2 > 0) add(warnings, 'land', 'open-ground', `${Math.round(openGroundM2)} m² of the land is open ground, which no owner brings in.`);

        const parties = landParties(agreement);
        const hashes = new Set(agreement.outputs.map(output => output.hash));
        agreement.allocations.forEach(({ output, to }) => {
            if (!hashes.has(output)) {
                add(errors, 'allocation', 'allocation-unknown-output', 'An allocation names a piece that is not among the outputs.', { output });
            } else if (to.kind === 'party') {
                if (!parties.has(to.ownerKey)) add(errors, 'allocation', 'allocation-unknown-party', `${to.ownerKey || 'The recipient'} holds no land in this agreement.`, { output, ownerKey: to.ownerKey });
            } else if (to.kind === 'joint') {
                const parsed = jointShares(to.shares);
                if (parsed.error) add(errors, 'allocation', 'allocation-shares-invalid', parsed.error.message, { output });
                else {
                    to.shares.filter(row => !parties.has(row.ownerKey)).forEach(row => {
                        add(errors, 'allocation', 'allocation-unknown-party', `${row.ownerKey} holds no land in this agreement.`, { output, ownerKey: row.ownerKey });
                    });
                }
            }
        });

        const { currency, lines } = agreement.money;
        if (currency !== 'EUR') add(errors, 'money', 'money-currency', 'Cash is settled in EUR.');
        lines.forEach(line => {
            if (!parties.has(line.ownerKey)) add(errors, 'money', 'money-party-unknown', `${line.ownerKey || 'A cash line'} holds no land in this agreement.`, { ownerKey: line.ownerKey });
            if (!Number.isSafeInteger(line.amountCents)) add(errors, 'money', 'money-amount-invalid', `The cash of ${line.ownerKey || 'a party'} is not a whole number of cents.`, { ownerKey: line.ownerKey });
        });

        const { electorate, binding, approvalConfig } = agreement.rule;
        if (!ELECTORATES.includes(electorate)) {
            add(errors, 'rule', 'rule-invalid', 'Choose who decides: the owners or the community.');
        } else if (electorate === 'community') {
            if (binding) add(errors, 'rule', 'rule-community-binding', 'A community vote cannot bind the owners.');
            if (approvalConfig !== null) add(errors, 'rule', 'rule-invalid', 'A community vote has no owner approval rule.');
        } else {
            let state = null;
            try { state = approval().inspect(approvalSubject(agreement)); } catch (error) {
                if (!error || error.code !== 'invalid-proposal-approval') throw error;
                add(errors, 'rule', 'rule-invalid', error.message);
            }
            if (state && !state.ready) add(warnings, 'rule', 'rule-not-ready', `The owners' decision cannot be counted yet (${state.reason}).`, { reason: state.reason });
            // Owners decide through signed decisions that a lens member verifies (approval-providers):
            // without a lens nobody can be verified, so the agreement can never be decided.
            if (!Array.isArray(agreement.rule.lens) || !agreement.rule.lens.length) add(warnings, 'rule', 'rule-lens-missing', 'No lens member is named, so no owner decision can be verified.');
        }

        const { deadline } = agreement;
        if (deadline !== null && !(typeof deadline === 'string' && Number.isFinite(Date.parse(deadline)))) {
            add(errors, 'details', 'deadline-invalid', 'The deadline is not a date.');
        }
        return { valid: !errors.length, errors, warnings };
    }

    /**
     * Per party: land brought in (inputs × share), land received (outputs × share by allocation),
     * the change, and cash (+ receives, − pays); the public share; and the balanced money schedule
     * with its computed sponsor line. Expects a record that validates: joint shares that do not
     * parse and cash that is not whole cents throw (code 'invalid-agreement').
     */
    function ledger(raw) {
        const agreement = normalize(raw);
        const parties = new Map();
        const party = (ownerKey, displayName) => {
            let entry = parties.get(ownerKey);
            if (!entry) {
                entry = { ownerKey, displayName: '', contributedM2: 0, assignedM2: 0, changeM2: 0, cashCents: 0, areaUnknown: false };
                parties.set(ownerKey, entry);
            }
            if (!entry.displayName && displayName) entry.displayName = displayName;
            return entry;
        };
        agreement.inputs.parcels.forEach(parcel => parcel.holders.forEach(holder => {
            const entry = party(holder.ownerKey, holder.displayName);
            if (parcel.areaM2 === null) entry.areaUnknown = true;
            else entry.contributedM2 += parcel.areaM2 * holder.share;
        }));
        agreement.outputs.forEach(output => output.holders.forEach(holder => party(holder.ownerKey, holder.displayName)));
        agreement.allocations.forEach(({ to }) => {
            if (to.kind === 'party') party(to.ownerKey);
            if (to.kind === 'joint') to.shares.forEach(row => party(row.ownerKey));
        });
        const allocated = new Map(agreement.allocations.map(line => [line.output, line.to]));
        let publicM2 = 0;
        agreement.outputs.forEach(output => {
            const to = allocated.get(output.hash) || HOLDERS;
            if (to.kind === 'public') publicM2 += output.areaM2;
            else if (to.kind === 'party') party(to.ownerKey).assignedM2 += output.areaM2;
            else {
                const parsed = to.kind === 'joint' ? jointShares(to.shares) : { shares: output.holders };
                if (parsed.error) fail(parsed.error.message);
                parsed.shares.forEach(row => { party(row.ownerKey).assignedM2 += output.areaM2 * row.share; });
            }
        });
        agreement.money.lines.forEach(line => {
            if (!Number.isSafeInteger(line.amountCents)) fail(`The cash of ${line.ownerKey} is not a whole number of cents.`);
            party(line.ownerKey).cashCents += line.amountCents;
        });
        const list = Array.from(parties.values(), entry => ({
            ...entry, displayName: entry.displayName || entry.ownerKey, changeM2: entry.assignedM2 - entry.contributedM2
        })).sort((a, b) => compare(a.displayName.toLowerCase(), b.displayName.toLowerCase()) || compare(a.displayName, b.displayName) || compare(a.ownerKey, b.ownerKey));
        const money = deal().schedule({
            ledger: agreement.money.lines.map(line => ({
                ownerKey: line.ownerKey, cashCents: Math.max(0, line.amountCents), payCents: Math.max(0, -line.amountCents)
            })),
            terms: { currency: agreement.money.currency }
        });
        return { parties: list, publicM2, money };
    }

    /**
     * The published agreement/v1 object (plan-design-agreement.md, M2): the designs linked by CID in
     * stored order, the input land with its holders snapshot, the output pieces without geometry
     * (each hash commits to it, and a reader re-derives the pieces by applying the designs), the
     * allocations, money and rule as stored, and the details. No local id, update time, piece ids,
     * output holders or fingerprints. Builds without judging: validate the record first.
     * The record as stored (normalize) keeps neither an author nor a parcel source, so both are read
     * from the object given: `{ ...stored, author }`, and a `parcelSourceId` on an input parcel.
     * @param designCidOf (proposalId) → that design's CID (DesignRecord.cidOf of its local record);
     *   asked for every design (refused unless it is a CID) and for every output's producedBy, where
     *   null means the producer is a design outside this agreement: the piece is then committed by
     *   its hash alone, and a reader whose ground lacks that design sees the agreement as stale.
     */
    function published(raw, designCidOf = null) {
        const agreement = normalize(raw);
        const stored = new Map(agreement.designs.map(design => [design.proposalId, design.cid]));
        const lookup = typeof designCidOf === 'function' ? designCidOf : proposalId => (stored.has(proposalId) ? stored.get(proposalId) : null);
        const cidOf = proposalId => {
            const value = lookup(proposalId);
            if (!cid().isCid(value)) fail(`Design ${proposalId} has no CID.`);
            return value;
        };
        const producerCidOf = proposalId => {
            const value = lookup(proposalId);
            return value === null || value === undefined ? null : cidOf(proposalId);
        };
        // normalize keeps the input parcels in their order, one for one.
        const sourceOf = index => keyOf(raw.inputs.parcels[index].parcelSourceId);
        return {
            schema: PUBLISHED_SCHEMA,
            title: agreement.title,
            author: textOf(raw.author),
            // The wallet that will mint and fund it (M3): part of the on-chain address, so only the
            // sponsor can create the agreement's account. Null when proposed without a wallet.
            sponsor: textOf(raw.sponsor),
            city: agreement.city,
            createdAt: agreement.createdAt,
            designs: agreement.designs.map(design => ({ cid: cidOf(design.proposalId), goal: design.goal, title: design.title })),
            inputs: {
                parcels: agreement.inputs.parcels.map((parcel, index) => {
                    const parcelSourceId = sourceOf(index);
                    return parcelSourceId
                        ? { parcelId: parcel.parcelId, parcelSourceId, areaM2: parcel.areaM2, holders: parcel.holders }
                        : { parcelId: parcel.parcelId, areaM2: parcel.areaM2, holders: parcel.holders };
                }),
                openGroundM2: agreement.inputs.openGroundM2
            },
            outputs: agreement.outputs.map(output => ({
                hash: output.hash,
                areaM2: output.areaM2,
                fromParcelIds: output.fromParcelIds,
                role: output.role,
                producedBy: output.producedBy === null ? null : producerCidOf(output.producedBy)
            })),
            allocations: agreement.allocations,
            money: agreement.money,
            rule: agreement.rule,
            deadline: agreement.deadline
        };
    }

    // The published object's identity: what decisions sign, mints commit to and links name.
    const publishedCid = (raw, designCidOf) => cid().cidOfObject(published(raw, designCidOf));

    return {
        SCHEMA, PUBLISHED_SCHEMA, OUTPUT_HASH_PREFIX, ROLES, newId, outputHash, normalize, validate, ledger,
        rightsFromInputs, approvalSubject, stableStringify, published, publishedCid
    };
});
