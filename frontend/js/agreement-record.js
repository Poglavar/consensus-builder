// The agreement as a browser record (plan-design-agreement.md, M1 (b)): its canonical form, the
// content hash of an output piece, validation by dialog section, the per-party ledger (land, and
// land value when the agreement settles by value), the settlement issues every path refuses the
// same way (settlement terms, land values, the named scheme's distribution rules, the derived cash),
// and the subject and default rights snapshot the approval engine counts; and its published
// agreement/v1 object with that object's CID (M2). Parties are abstract: each input parcel is one
// party, its owner(s); real people live only in the rule's rights snapshot (agreement-persons.js).
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
    // How differences between what a party puts in and gets back are settled: 'area' (a rate per m²
    // of land, after an allowed contribution), 'value' (land values per m², value shares) or 'none'.
    const METHODS = ['area', 'value', 'none'];
    const DEFAULT_SETTLEMENT = Object.freeze({ method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 0 });
    const regimes = () => root.ProposalApprovalRegimes
        || (typeof require === 'function' ? require('./proposals/approval-regimes.js') : null);

    // Every input parcel is one abstract party, "Owner(s) of parcel X". An agreement never names real
    // people: allocations and cash go to these parties, and a rights snapshot only derives what each
    // person holds of them (agreement-persons.js).
    const PARTY_PREFIX = 'parcel-owner:';
    const partyKey = parcelId => PARTY_PREFIX + String(parcelId);
    const parcelOfParty = key => (typeof key === 'string' && key.startsWith(PARTY_PREFIX) ? key.slice(PARTY_PREFIX.length) : null);
    const partyName = parcelId => `Owner(s) of parcel ${parcelId}`;
    // Money is counted in the agreement's city's currency (city-money.js: London GBP, Zagreb EUR).
    const cityMoney = () => root.CityMoney || (typeof require === 'function' ? require('./city-money.js') : null);
    const sha256 = () => root.__consentSha256
        || (typeof require === 'function' ? require('../vendor/noble-hashes-1.8.0/sha256.js') : null);
    const approval = () => root.ProposalApproval
        || (typeof require === 'function' ? require('./proposals/approval.js') : null);
    const deal = () => root.ReparcellizationDeal
        || (typeof require === 'function' ? require('./reparcellization-deal.js') : null);
    const planRecord = () => root.PlanRecord
        || (typeof require === 'function' ? require('./plan-record.js') : null);
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
            if (Object.hasOwn(parcel, 'holders')) {
                fail(`Input parcel ${parcelId} names holders. Agreement parties are abstract: the parcel is represented by ${partyKey(parcelId)}; put its owners in the rule's ownership rights.`);
            }
            return {
                parcelId,
                ...(parcel.parcelSourceId == null ? {} : { parcelSourceId: idOf(parcel.parcelSourceId, 'The parcel source') }),
                areaM2: areaOf(parcel.areaM2, `Input parcel ${parcelId}`, true)
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
                geometry
            };
        });
    }

    // Every output has one explicit input party, proposer or public recipient. validate checks its membership.
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
            if (kind === 'public' || kind === 'proposer') return { output, to: { kind } };
            if (kind === 'party') return { output, to: { kind, ownerKey: keyOf(line.to.ownerKey) } };
            if (kind === 'joint' || kind === 'holders') fail('Choose one recipient for each output parcel. Split the parcel to allocate land to different persons.');
            return fail(`Unknown allocation kind ${String(kind)}.`);
        });
    }

    // A zero line is no line. Amounts and the currency are kept as given; validate reports them.
    function moneyOf(raw) {
        if (raw === undefined || raw === null) return { currency: null, lines: [] };
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
        return { currency: raw.currency == null ? null : String(raw.currency).trim().toUpperCase(), lines };
    }

    // Land values for settlement by value: one unit value (whole cents per m²) per input parcel and
    // per output piece. Kept as given; validate reports a value that is not one, or one that is
    // missing. null when the agreement states none.
    function valuationOf(raw) {
        if (raw === undefined || raw === null) return null;
        if (!isObject(raw)) fail('Valuation must be an object.');
        const rows = (list, key, what) => {
            if (list === undefined || list === null) return [];
            if (!Array.isArray(list)) fail(`Valuation ${what}s must be a list.`);
            const seen = new Set();
            return list.map(row => {
                if (!isObject(row)) fail(`A ${what} valuation row is invalid.`);
                const id = keyOf(row[key]);
                if (!id) fail(`A ${what} valuation row names no ${key}.`);
                if (seen.has(id)) fail(`${what} ${id} has two unit values.`);
                seen.add(id);
                return { [key]: id, unitValueCents: row.unitValueCents };
            });
        };
        return { inputs: rows(raw.inputs, 'parcelId', 'input parcel'), outputs: rows(raw.outputs, 'output', 'output') };
    }

    // A unit value as the ledger counts it: whole cents of at least 0, else null (unknown).
    const unitCents = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
    // The agreement's unit values by parcel id and by output hash; null without a valuation.
    function unitValues(agreement) {
        if (!agreement.valuation) return null;
        return {
            inputs: new Map(agreement.valuation.inputs.map(row => [row.parcelId, unitCents(row.unitValueCents)])),
            outputs: new Map(agreement.valuation.outputs.map(row => [row.output, unitCents(row.unitValueCents)]))
        };
    }

    function ruleOf(raw) {
        if (!isObject(raw)) fail('The agreement needs a decision rule.');
        return {
            electorate: typeof raw.electorate === 'string' ? raw.electorate.trim() : null,
            binding: raw.binding === true,
            approvalConfig: raw.approvalConfig == null ? null : clone(raw.approvalConfig),
            lens: raw.lens == null ? [] : clone(raw.lens),
            settlement: raw.electorate === 'community' ? null : { ...(raw.settlement || DEFAULT_SETTLEMENT) }
        };
    }

    const didWeb = () => root.CommunityDidWeb
        || (typeof require === 'function' ? require('./community/did-web.js') : null);

    function participationUrl(value) {
        const text = textOf(value);
        if (!text) return null;
        if (text.length > 2048) throw new TypeError('Participation URL is too long.');
        const url = new URL(text);
        if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('Participation URL must use HTTPS without credentials.');
        return url.href;
    }

    // Invalid typed fields remain visible for section validation; valid fields are canonicalized.
    function consultationOf(raw, electorate) {
        if (electorate !== 'community') {
            if (raw != null) fail('Only a community agreement can have agreement participation metadata.');
            return null;
        }
        if (raw != null && !isObject(raw)) fail('Participation metadata must be an object.');
        if (raw && Object.keys(raw).some(key => !['organiser', 'participationUrl', 'voting'].includes(key))) fail('Participation metadata has unknown fields.');
        if (raw && ['organiser', 'participationUrl'].some(key => raw[key] != null && typeof raw[key] !== 'string')) fail('Participation fields must be text or null.');
        const result = { organiser: textOf(raw && raw.organiser), participationUrl: textOf(raw && raw.participationUrl) };
        if (raw?.voting != null) {
            const voting = root.CommunityVoting || (typeof require === 'function' ? require('./community/voting.js') : null);
            result.voting = voting.configuration(raw.voting);
        }
        if (result.organiser) { try { result.organiser = didWeb().normalizeDid(result.organiser); } catch (_) { /* validate reports it */ } }
        if (result.participationUrl) { try { result.participationUrl = participationUrl(result.participationUrl); } catch (_) { /* validate reports it */ } }
        return result;
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
    // Where the agreement went when it was proposed (M2): its CID, when, the index it was sent to and
    // the wallet that sponsors it (the published object's `sponsor`, null when proposed without one;
    // M3 mints at PDA(sponsor, cid), so only that wallet can mint it). Absent until then; a published
    // agreement is immutable, its CID is what decisions sign.
    function publishedOf(raw) {
        if (raw === undefined || raw === null) return null;
        if (!isObject(raw)) fail('published must be an object.');
        if (!cid().isCid(raw.cid)) fail('published.cid must be a CID.');
        const apiBase = textOf(raw.apiBase);
        if (!apiBase) fail('published.apiBase is required.');
        return { cid: raw.cid, publishedAt: timestampOf(raw.publishedAt, 'published.publishedAt'), apiBase, sponsor: textOf(raw.sponsor) };
    }

    // Where the agreement is minted (M3): the chain account the index mirrors, kept as given
    // ({ chain: 'solana', cluster, account, signature? }, agreement-sync.js recordOnchain). Absent
    // until minted; the chain is the truth, so the panel reads the account itself for its state.
    function onchainOf(raw) {
        if (raw === undefined || raw === null) return null;
        if (!isObject(raw)) fail('onchain must be an object.');
        return clone(raw);
    }

    // The plan owns membership. Local design references are an editing/replay projection;
    // publication commits only this verified immutable plan's CID.
    function planReference(value) {
        if (!isObject(value) || !cid().isCid(value.cid)) fail('Choose a plan for this agreement.');
        const error = planRecord().validate(value.content);
        if (error) fail(error);
        if (cid().cidOfObject(value.content) !== value.cid) fail('The plan does not match its content identifier.');
        return { cid: value.cid, content: clone(value.content) };
    }

    function matchesPlan(plan, designCids) {
        const members = plan?.content?.designCids;
        const unique = new Set(designCids);
        return Array.isArray(members) && unique.size === designCids.length
            && members.length === unique.size && members.every(value => unique.has(value));
    }

    function normalize(raw) {
        if (!isObject(raw) || raw.schema !== SCHEMA) fail(`Expected ${SCHEMA}.`);
        const rule = ruleOf(raw.rule);
        return {
            schema: SCHEMA,
            id: idOf(raw.id, 'The agreement'),
            title: textOf(raw.title),
            author: textOf(raw.author),
            sponsor: textOf(raw.sponsor),
            city: textOf(raw.city),
            createdAt: timestampOf(raw.createdAt, 'createdAt'),
            updatedAt: timestampOf(raw.updatedAt, 'updatedAt'),
            plan: raw.plan == null ? null : planReference(raw.plan),
            designs: designsOf(raw.designs),
            inputs: inputsOf(raw.inputs),
            outputs: outputsOf(raw.outputs),
            allocations: allocationsOf(raw.allocations),
            money: moneyOf(raw.money),
            valuation: valuationOf(raw.valuation),
            rule,
            consultation: consultationOf(raw.consultation, rule.electorate),
            deadline: deadlineOf(raw.deadline),
            published: publishedOf(raw.published),
            onchain: onchainOf(raw.onchain)
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

    // The default rights snapshot as parcel-rights/v1: each input parcel's owners from the local owner
    // records (`ownerOf(parcelId)` → [{ ownerKey, share }], AgreementGround.localHolders), shares in
    // basis points with the last holder taking the remainder. A parcel nobody is recorded for keeps
    // its abstract party as its one owner and is incomplete.
    function rightsFromInputs(inputs, ownerOf = () => []) {
        const parcels = ((inputs && inputs.parcels) || []).map(parcel => {
            const recorded = ownerOf(String(parcel.parcelId));
            const named = Array.isArray(recorded) && recorded.length > 0;
            const holders = named ? recorded : [{ ownerKey: partyKey(parcel.parcelId), share: 1 }];
            let given = 0;
            const owners = holders.map((holder, index) => {
                const points = index === holders.length - 1 ? BASIS_POINTS - given : Math.round(holder.share * BASIS_POINTS);
                given += points;
                return { ownerId: String(holder.ownerKey), share: `${points}/${BASIS_POINTS}` };
            });
            // Whole square metres: the rights file is read by people, and the engine's area tests
            // need no more than that; a sub-metre parcel still counts as one.
            const areaM2 = finite(parcel.areaM2) && parcel.areaM2 > 0 ? Math.max(1, Math.round(parcel.areaM2)) : null;
            return { parcelId: String(parcel.parcelId), complete: named, areaM2, owners };
        });
        return { schema: approval().RIGHTS_SCHEMA, source: { provider: 'local-owners' }, parcels };
    }

    // Only input-land parties (one per input parcel) may receive output parcels or balancing cash.
    function landParties(agreement) {
        return new Set(agreement.inputs.parcels.map(parcel => partyKey(parcel.parcelId)));
    }

    // A piece standing on one input parcel goes back to that parcel's party by default. A piece on
    // several parcels requires an explicit choice.
    function defaultAllocations(inputs, outputs) {
        const parcelIds = new Set((inputs?.parcels || []).map(parcel => String(parcel.parcelId)));
        return (outputs || []).flatMap(output => {
            const from = output.fromParcelIds?.length === 1 ? String(output.fromParcelIds[0]) : null;
            return from !== null && parcelIds.has(from) ? [{ output: output.hash, to: { kind: 'party', ownerKey: partyKey(from) } }] : [];
        });
    }

    function contributionLimit(rule) {
        const regime = rule?.approvalConfig?.regime;
        const template = regime ? regimes().get(regime.id, regime.version) : null;
        const cap = template?.allocation?.cap;
        return cap && template.allocation.basis !== 'value' ? Math.floor(cap.numerator / cap.denominator * BASIS_POINTS) : 0;
    }

    function landBalance(raw) {
        const inputs = raw.inputs.parcels;
        const known = inputs.every(parcel => finite(parcel.areaM2));
        const inputM2 = known ? inputs.reduce((sum, parcel) => sum + parcel.areaM2, raw.inputs.openGroundM2 || 0) : null;
        const outputM2 = raw.outputs.reduce((sum, output) => sum + output.areaM2, 0);
        return { inputM2, outputM2, balanced: known && Math.abs(inputM2 - outputM2) <= Math.max(0.01, inputM2 * 1e-6) };
    }

    // The rate and the contribution belong to settlement by area; by value and without cash both are 0.
    function settlementValid(rule) {
        const terms = rule.settlement;
        return !!terms && Object.keys(terms).every(key => ['method', 'rateCentsPerM2', 'contributionBasisPoints'].includes(key)) && METHODS.includes(terms.method)
            && Number.isSafeInteger(terms.rateCentsPerM2) && terms.rateCentsPerM2 >= 0
            && Number.isInteger(terms.contributionBasisPoints) && terms.contributionBasisPoints >= 0
            && terms.contributionBasisPoints <= contributionLimit(rule)
            && (terms.method === 'area' || terms.contributionBasisPoints === 0)
            && (terms.method !== 'value' || terms.rateCentsPerM2 === 0);
    }

    // The scheme a rule names (approval-regimes.js), or null for custom and unanimous rules.
    function schemeOf(rule) {
        const regime = rule?.approvalConfig?.regime;
        return regime ? regimes().get(regime.id, regime.version) : null;
    }

    // By value, the share of each owner's value gain the scheme settles in money (0 to 1).
    const valueGainOf = rule => regimes().valueGainRatio(schemeOf(rule));

    /**
     * The agreement's land distribution against a scheme's rules (approval-regimes.js checkAllocation):
     * the scheme its rule names, or `template` to try another one. null without a scheme.
     * @returns {{ template: object, check: { ok: boolean|null, rules: object[] } } | null}
     */
    function schemeCheck(raw, template) {
        const agreement = normalize(raw);
        const scheme = template === undefined ? schemeOf(agreement.rule) : template;
        if (!scheme) return null;
        const rows = ledger(agreement);
        const owners = rows.parties.filter(party => !party.areaUnknown && party.contributedM2 > 0)
            .map(party => ({ ownerKey: party.ownerKey, contributedAreaM2: party.contributedM2, assignedAreaM2: party.assignedM2 }));
        const facts = {
            basis: agreement.rule.settlement?.method === 'value' ? 'value' : 'area',
            poolAreaM2: landBalance(agreement).inputM2, owners,
            partyCount: approval().participantTally(approvalSubject(agreement), [], scheme)?.total ?? null, proposerAreaM2: rows.proposerM2
        };
        return { template: scheme, check: regimes().checkAllocation(scheme, facts) };
    }

    // Cash is derived from each party's entitlement, in whole cents. The sponsor is the balancing
    // counterparty when public land is compensated; no editable per-person cash overrides exist.
    // By area: (land put in after the allowed contribution − land received) × the rate.
    // By value: each party is entitled to the share of the distributed land's value that matches the
    // value it put in; it receives the entitlement minus the value it got, and pays the scheme's
    // share of its value gain (the entitlement minus the value it put in). Lines need every value.
    function settle(raw) {
        const agreement = normalize(raw);
        const terms = agreement.rule.settlement;
        agreement.money.lines = [];
        if (agreement.rule.electorate !== 'owners' || !['area', 'value'].includes(terms?.method)) return agreement;
        const rows = ledger(agreement);
        if (terms.method === 'area') {
            agreement.money.lines = rows.parties.filter(row => !row.areaUnknown).map(row => ({
                ownerKey: row.ownerKey,
                amountCents: Math.round((row.contributedM2 * (1 - terms.contributionBasisPoints / BASIS_POINTS) - row.assignedM2) * terms.rateCentsPerM2)
            })).filter(line => line.amountCents !== 0);
            return agreement;
        }
        if (!rows.valued || !(rows.contributedValueCents > 0)) return agreement;
        const gain = valueGainOf(agreement.rule);
        agreement.money.lines = rows.parties.map(row => ({
            ownerKey: row.ownerKey,
            amountCents: Math.round((row.entitlementValueCents - row.assignedValueCents) - gain * (row.entitlementValueCents - row.contributedValueCents))
        })).filter(line => line.amountCents !== 0);
        return agreement;
    }

    const percentText = ratio => `${Math.round(ratio * 1000) / 10}%`;
    const schemeName = template => template.text?.name || template.id;

    // A failing distribution rule of a scheme as a validation issue: which section of the dialog
    // fixes it, and what it says in the validator's own words.
    function schemeIssue(template, rule, ownerNames = new Map()) {
        const name = schemeName(template);
        const basis = value => (value === 'value' ? 'land value' : 'surface area');
        const extra = { rule, scheme: template.id, version: template.version };
        if (rule.kind === 'basis') return { code: 'scheme-basis', section: 'rule', message: `${name} distributes by ${basis(rule.required)}; this agreement settles by ${basis(rule.actual)}.`, ...extra };
        if (rule.kind === 'parties') return { code: 'scheme-parties', section: 'land', message: `The land has ${rule.actual} distinct owners; ${name} needs at least ${rule.required}.`, ...extra };
        if (rule.kind === 'proposer') return { code: 'scheme-proposer', section: 'allocation', message: `${name} is authority-led: land returns to its owners or goes to public use, so a proposer cannot acquire ${Math.round(rule.areaM2)} m².`, ...extra };
        const limit = percentText(rule.limit.numerator / rule.limit.denominator);
        if (rule.per === 'owner') {
            const ownerName = ownerNames.get(rule.worst.ownerKey) || rule.worst.ownerKey;
            return { code: 'scheme-cap', section: 'allocation', message: `${ownerName} gives up ${percentText(rule.worst.given)} of their land; ${name} allows at most ${limit}.`, ownerKey: rule.worst.ownerKey, ownerName, ...extra };
        }
        return { code: 'scheme-cap', section: 'allocation', message: rule.given === null
            ? `The pool area is unknown, so the ${limit} cap of ${name} cannot be checked.`
            : `${percentText(rule.given)} of the land is not returned to owners; ${name} allows at most ${limit}.`, ...extra };
    }

    /**
     * The compensation issues of an owners' agreement: its settlement terms, the land values that
     * settlement by value needs, the distribution rules of the scheme its rule names, and the cash
     * lines against the ones derived from all of that. The record, the HTTP index and MCP all judge
     * an agreement with this one list. Empty for a community agreement.
     * @returns {{ code, message, section, ... }[]}
     */
    function settlementIssues(raw) {
        const agreement = normalize(raw);
        const issues = [];
        const add = (section, code, message, extra) => { issues.push({ code, message, section, ...extra }); };
        if (agreement.rule.electorate !== 'owners') return issues;
        if (!settlementValid(agreement.rule)) {
            add('rule', 'settlement-invalid', 'Set a valid compensation rate and a land contribution within the selected scheme’s limit.');
            return issues;
        }
        const { valuation } = agreement;
        let valuesReady = true;
        if (agreement.rule.settlement.method === 'value') {
            const values = unitValues(agreement);
            const rows = valuation ? [...valuation.inputs, ...valuation.outputs] : [];
            if (rows.some(row => unitCents(row.unitValueCents) === null)) add('money', 'valuation-invalid', 'A value per m² must be a whole number of cents of at least 0.');
            const missing = [...agreement.inputs.parcels.filter(parcel => !values?.inputs.has(parcel.parcelId)).map(parcel => parcel.parcelId),
                ...agreement.outputs.filter(output => !values?.outputs.has(output.hash)).map(output => output.pieceId)];
            if (missing.length) add('money', 'valuation-missing', `Settlement by value needs a value per m² for every input parcel and every output parcel; missing: ${missing.join(', ')}.`, { missing });
            if (valuation && (valuation.inputs.some(row => !agreement.inputs.parcels.some(parcel => parcel.parcelId === row.parcelId))
                || valuation.outputs.some(row => !agreement.outputs.some(output => output.hash === row.output)))) {
                add('money', 'valuation-unknown', 'A value per m² names a parcel or piece that is not in this agreement.');
            }
            valuesReady = !issues.length;
            if (valuesReady && !(ledger(agreement).contributedValueCents > 0)) { add('money', 'valuation-zero', 'The input land needs a value above zero to settle by value.'); valuesReady = false; }
        } else if (valuation) {
            add('money', 'valuation-unused', 'Land values apply to settlement by value only; remove them or choose that compensation.');
        }
        const scheme = schemeCheck(agreement);
        if (scheme) {
            const ownerNames = new Map(agreement.inputs.parcels.map(parcel => [partyKey(parcel.parcelId), partyName(parcel.parcelId)]));
            scheme.check.rules.filter(rule => rule.ok === false).forEach(rule => issues.push(schemeIssue(scheme.template, rule, ownerNames)));
        }
        if (valuesReady) {
            const expected = settle(agreement).money.lines;
            const sorted = list => [...list].sort((a, b) => compare(a.ownerKey, b.ownerKey));
            if (expected.some(line => !Number.isSafeInteger(line.amountCents))
                || stableStringify(sorted(expected)) !== stableStringify(sorted(agreement.money.lines))) {
                add('money', 'money-unbalanced', 'Payments must match the compensation calculated from the rules and allocations.');
            }
        }
        return issues;
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
        if (!agreement.plan) add(errors, 'designs', 'plan-required', 'Create a plan first, then select it for this agreement.');
        else if (!matchesPlan(agreement.plan, agreement.designs.map(design => design.cid))) {
            add(errors, 'designs', 'plan-membership', 'The designs differ from the selected plan. Save a plan revision first.');
        }
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
        const balance = landBalance(agreement);
        if (!balance.balanced) add(errors, 'land', 'land-unbalanced', balance.inputM2 === null
            ? 'Measure all input parcels before saving the agreement.' : 'The input and output land areas do not balance.');

        const parties = landParties(agreement);
        const hashes = new Set(agreement.outputs.map(output => output.hash));
        if (agreement.rule.electorate === 'owners') {
            const allocated = new Set(agreement.allocations.map(line => line.output));
            agreement.outputs.filter(output => !allocated.has(output.hash)).forEach(output =>
                add(errors, 'allocation', 'allocation-required', 'Choose one recipient for every output parcel.', { output: output.hash }));
        }
        agreement.allocations.forEach(({ output, to }) => {
            if (!hashes.has(output)) {
                add(errors, 'allocation', 'allocation-unknown-output', 'An allocation names a piece that is not among the outputs.', { output });
            } else if (to.kind === 'party') {
                if (!parties.has(to.ownerKey)) add(errors, 'allocation', 'allocation-unknown-party', `${to.ownerKey || 'The recipient'} holds no land in this agreement.`, { output, ownerKey: to.ownerKey });
            }
        });

        const { currency, lines } = agreement.money;
        if (!cityMoney().isFiat(currency)) add(errors, 'money', 'money-currency', 'Money is counted in the currency of the agreement\'s city (an ISO 4217 code).');
        lines.forEach(line => {
            if (!parties.has(line.ownerKey)) add(errors, 'money', 'money-party-unknown', `${line.ownerKey || 'A cash line'} holds no land in this agreement.`, { ownerKey: line.ownerKey });
            if (!Number.isSafeInteger(line.amountCents)) add(errors, 'money', 'money-amount-invalid', `The cash of ${line.ownerKey || 'a party'} is not a whole number of cents.`, { ownerKey: line.ownerKey });
        });

        const { electorate, binding, approvalConfig } = agreement.rule;
        if (!ELECTORATES.includes(electorate)) {
            add(errors, 'rule', 'rule-invalid', 'Choose who decides: the owners or the community.');
        } else if (electorate === 'community') {
            if (Array.isArray(raw.allocations) && raw.allocations.length) add(errors, 'allocation', 'community-allocations', 'A nonbinding agreement cannot allocate land.');
            if (raw.money && Array.isArray(raw.money.lines) && raw.money.lines.length) add(errors, 'money', 'community-money', 'A nonbinding agreement cannot include cash payments.');
            if (binding) add(errors, 'rule', 'rule-community-binding', 'A community vote cannot bind the owners.');
            if (approvalConfig !== null) add(errors, 'rule', 'rule-invalid', 'A community vote has no owner approval rule.');
        } else {
            settlementIssues(agreement).forEach(issue => errors.push(issue));
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

        if (agreement.consultation) {
            const consultation = agreement.consultation;
            if (consultation.organiser) {
                try { didWeb().normalizeDid(consultation.organiser); } catch (_) {
                    add(errors, 'consultation', 'consultation-organiser', 'Enter an organiser website or a valid did:web identifier.');
                }
            }
            if (consultation.participationUrl) {
                try { participationUrl(consultation.participationUrl); } catch (_) {
                    add(errors, 'consultation', 'consultation-participation-url', 'Enter an HTTPS participation URL without credentials.');
                }
            }
        }

        const { deadline } = agreement;
        if (deadline !== null && !(typeof deadline === 'string' && Number.isFinite(Date.parse(deadline)))) {
            add(errors, 'details', 'deadline-invalid', 'The deadline is not a date.');
        }
        return { valid: !errors.length, errors, warnings };
    }

    /**
     * Per input party (one per input parcel): its parcel's land, whole output parcels assigned to it,
     * entitlement and change, and cash (+ receives, − pays). Public and proposer land and the balancing sponsor
     * are separate. Cash that is not whole cents throws (code 'invalid-agreement').
     * With a valuation, also the land value each party put in and got (contributedValueCents,
     * assignedValueCents), its value entitlement (its share of the value of the land distributed to
     * parties and the proposer, by the value it put in) and the totals; `valued` says whether every
     * value needed for that is known, and the value fields are null where it is not.
     */
    function ledger(raw) {
        const agreement = normalize(raw);
        const values = unitValues(agreement);
        const parties = new Map();
        const party = (ownerKey, displayName) => {
            let entry = parties.get(ownerKey);
            if (!entry) {
                entry = { ownerKey, parcelId: parcelOfParty(ownerKey), displayName: '', contributedM2: 0, assignedM2: 0, changeM2: 0, cashCents: 0, areaUnknown: false,
                    contributedValueCents: 0, assignedValueCents: 0, valueUnknown: !values };
                parties.set(ownerKey, entry);
            }
            if (!entry.displayName && displayName) entry.displayName = displayName;
            return entry;
        };
        agreement.inputs.parcels.forEach(parcel => {
            const entry = party(partyKey(parcel.parcelId), partyName(parcel.parcelId));
            if (parcel.areaM2 === null) entry.areaUnknown = true;
            else entry.contributedM2 += parcel.areaM2;
            const unit = values ? values.inputs.get(parcel.parcelId) : null;
            if (parcel.areaM2 === null || unit === null || unit === undefined) entry.valueUnknown = true;
            else entry.contributedValueCents += parcel.areaM2 * unit;
        });
        agreement.allocations.forEach(({ to }) => {
            if (to.kind === 'party') party(to.ownerKey);
        });
        const allocated = new Map(agreement.allocations.map(line => [line.output, line.to]));
        let publicM2 = 0, proposerM2 = 0, publicValueCents = 0, proposerValueCents = 0, outputValueUnknown = !values;
        agreement.outputs.forEach(output => {
            const to = allocated.get(output.hash);
            if (!to) return;
            const unit = values ? values.outputs.get(output.hash) : null;
            const value = unit === null || unit === undefined ? null : output.areaM2 * unit;
            if (value === null) outputValueUnknown = true;
            if (to.kind === 'public') { publicM2 += output.areaM2; publicValueCents += value || 0; }
            else if (to.kind === 'proposer') { proposerM2 += output.areaM2; proposerValueCents += value || 0; }
            else if (to.kind === 'party') {
                const entry = party(to.ownerKey);
                entry.assignedM2 += output.areaM2;
                if (value === null) entry.valueUnknown = true; else entry.assignedValueCents += value;
            }
        });
        agreement.money.lines.forEach(line => {
            if (!Number.isSafeInteger(line.amountCents)) fail(`The cash of ${line.ownerKey} is not a whole number of cents.`);
            party(line.ownerKey).cashCents += line.amountCents;
        });
        const entries = Array.from(parties.values());
        const valued = !outputValueUnknown && entries.every(entry => !entry.valueUnknown);
        // The value the parties put in, and the value of the land that goes back to parties or to a
        // proposer (public land is outside the distribution): the entitlement shares the latter by the
        // former. Shares are taken on the exact sums and rounded once, so a party that keeps all its
        // land is entitled to exactly what it got; the sponsor line absorbs the odd cent of a split.
        const contributed = entries.reduce((sum, entry) => sum + entry.contributedValueCents, 0);
        const distributable = entries.reduce((sum, entry) => sum + entry.assignedValueCents, 0) + proposerValueCents;
        const contributedValueCents = valued ? Math.round(contributed) : null;
        const distributableValueCents = valued ? Math.round(distributable) : null;
        const list = entries.map(entry => ({
            ...entry, displayName: entry.displayName || entry.ownerKey, changeM2: entry.assignedM2 - entry.contributedM2,
            entitlementM2: entry.areaUnknown ? null : entry.contributedM2 * (1 - (agreement.rule.settlement?.contributionBasisPoints || 0) / BASIS_POINTS),
            contributedValueCents: entry.valueUnknown ? null : Math.round(entry.contributedValueCents),
            assignedValueCents: entry.valueUnknown ? null : Math.round(entry.assignedValueCents),
            entitlementValueCents: valued && contributed > 0 ? Math.round(distributable * (entry.contributedValueCents / contributed)) : null
        })).sort((a, b) => compare(a.displayName.toLowerCase(), b.displayName.toLowerCase()) || compare(a.displayName, b.displayName) || compare(a.ownerKey, b.ownerKey));
        const money = deal().schedule({
            ledger: agreement.money.lines.map(line => ({
                ownerKey: line.ownerKey, cashCents: Math.max(0, line.amountCents), payCents: Math.max(0, -line.amountCents)
            })),
            terms: { currency: agreement.money.currency }
        });
        return { parties: list, publicM2, proposerM2, money, currency: agreement.money.currency, valued, contributedValueCents, distributableValueCents,
            publicValueCents: valued ? Math.round(publicValueCents) : null, proposerValueCents: valued ? Math.round(proposerValueCents) : null,
            valueGain: valueGainOf(agreement.rule) };
    }

    /**
     * The published agreement/v1 object: one exact plan CID, the input land (each parcel standing for
     * its abstract owners' party; no people), the output pieces without geometry
     * (each hash commits to it, and a reader re-derives the pieces by applying the designs), the
     * allocations, money and rule as stored, and the details. No local id, update time, piece ids,
     * or fingerprints. Builds without judging: validate the record first.
     * The stored record retains author, sponsor and input parcel source identity; a publisher may
     * explicitly override author or sponsor on the object passed to this function.
     * @param designCidOf (proposalId) → that design's CID (DesignRecord.cidOf of its local record);
     *   asked for every design (refused unless it is a CID) and for every output's producedBy, where
     *   null means the producer is a design outside this agreement: the piece is then committed by
     *   its hash alone, and a reader whose ground lacks that design sees the agreement as stale.
     */
    function published(raw, designCidOf = null) {
        const agreement = normalize(raw);
        if (agreement.rule.electorate === 'community' && ((raw.allocations && raw.allocations.length) || (raw.money && raw.money.lines && raw.money.lines.length))) {
            fail('A nonbinding agreement cannot allocate land or include cash payments.');
        }
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
        const plan = planReference(agreement.plan);
        if (!matchesPlan(plan, agreement.designs.map(design => cidOf(design.proposalId)))) {
            fail('The selected designs differ from the referenced plan. Save a new plan revision first.');
        }
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
            planCid: plan.cid,
            inputs: {
                parcels: agreement.inputs.parcels.map((parcel, index) => {
                    const parcelSourceId = sourceOf(index);
                    return parcelSourceId
                        ? { parcelId: parcel.parcelId, parcelSourceId, areaM2: parcel.areaM2 }
                        : { parcelId: parcel.parcelId, areaM2: parcel.areaM2 };
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
            valuation: agreement.valuation,
            rule: agreement.rule,
            consultation: agreement.consultation,
            deadline: agreement.deadline
        };
    }

    // The published object's identity: what decisions sign, mints commit to and links name.
    const publishedCid = (raw, designCidOf) => cid().cidOfObject(published(raw, designCidOf));

    return {
        SCHEMA, PUBLISHED_SCHEMA, OUTPUT_HASH_PREFIX, ROLES, newId, outputHash, normalize, validate, ledger,
        rightsFromInputs, approvalSubject, stableStringify, published, publishedCid, consultationOf, participationUrl,
        planReference, matchesPlan, PARTY_PREFIX, partyKey, parcelOfParty, partyName, landParties, defaultAllocations, settle, landBalance, contributionLimit, settlementValid, DEFAULT_SETTLEMENT,
        METHODS, schemeOf, schemeCheck, settlementIssues, valueGainOf
    };
});
