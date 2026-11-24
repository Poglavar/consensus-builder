// Common result fields are typed at the MCP boundary; authored/source-specific payloads stay data.
import * as z from 'zod/v4';
import { MAX_SOURCE_BINDING_PARCELS } from '../parcels/source-binding.js';

const object = z.record(z.string(), z.unknown());
export const mcpResultSchema = z.object({
    cid: z.string().optional(), previousCid: z.string().optional(),
    draftRef: z.string().url().optional(), previewUrl: z.string().url().nullable().optional(),
    url: z.string().url().optional(), approvalUrl: z.string().url().nullable().optional(),
    previewStatus: z.enum(['private-link', 'private-artifact']).optional(),
    previewExpiresAt: z.string().optional(), publication: z.union([z.enum(['private', 'published']), object]).optional(),
    parcelSourceId: z.string().nullable().optional(),
    total: z.number().int().nonnegative().optional(), offset: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(), items: z.array(object).optional(),
    values: z.array(z.object({ path: z.string(), untrustedValue: z.unknown() })).optional(),
    warnings: z.array(z.union([z.string(), object])).optional(),
    untrusted: object.optional(), next: object.optional(),
    code: z.string().optional(), message: z.string().optional(), field: z.string().optional(),
    constraints: z.unknown().optional(), issues: z.array(object).optional(),
    currentCid: z.string().optional(), expectedCid: z.string().optional(),
    status: z.number().int().optional(), retryable: z.boolean().optional(), retryAfter: z.number().nonnegative().optional(),
    stage: z.string().optional(), publishedCids: z.array(z.string()).optional(), indexed: z.boolean().optional()
}).passthrough();

// Successful authoring responses have stable envelopes even though their authored records and
// source payloads are extensible. Error results use the common recovery fields: the MCP SDK
// deliberately skips successful-output validation when isError is true.
const cid = z.string().regex(/^baf(?:krei|ybei)[a-z2-7]{52}$/);
const count = z.number().int().nonnegative();
const record = schema => z.object({ schema: z.literal(schema) }).passthrough();
const authored = schema => z.object({ [schema.split('/')[0]]: record(schema) }).passthrough();
const privatePreview = {
    previewStatus: z.enum(['private-link', 'private-artifact']),
    previewUrl: z.string().url().nullable()
};
const designDraft = mcpResultSchema.extend({ cid, untrusted: authored('design/v1'), ...privatePreview });
// Every authored design is placed in the agent's working plan (docs/agent-working-plan.md): the new plan
// revision (or the unchanged one after a refusal), the placement and what it changed in the plan.
const placement = {
    plan: z.object({ cid }).passthrough().nullable(),
    placement: z.object({ status: z.enum(['placed', 'refused']) }).passthrough(),
    consequences: z.object({ removed: z.array(object), junctions: z.array(object), cuts: z.array(object) })
};
const placedDesign = designDraft.extend(placement);
const agreementDraft = mcpResultSchema.extend({ cid, untrusted: authored('agreement/v1'), designs: z.array(object), ...privatePreview });
const planResult = mcpResultSchema.extend({ cid, untrusted: authored('plan/v1'), designs: z.array(z.object({ cid }).passthrough()).min(1), publication: z.enum(['private', 'published']) });
const sharedPlanSession = mcpResultSchema.extend({ id: z.string().regex(/^[\w-]{24}$/), version: z.number().int().nonnegative(),
    controller: z.enum(['owner', 'agent']), cid, updatedAt: z.string(), expiresAt: z.string(),
    publicationApproval: z.object({ cid, version: count, approvedAt: z.string() }).nullable(), artifact: object, canUndo: z.boolean(), lastChange: z.object({ fromCid: cid, toCid: cid, actor: z.enum(['owner', 'agent']), kind: z.enum(['edit', 'undo']), members: z.array(z.object({ beforeCid: cid.optional(), afterCid: cid.optional(), ref: z.string().optional(), type: z.string().optional() })) }).nullable() });
const inventory = mcpResultSchema.extend({ cid, items: z.array(z.object({ ref: z.string(), kind: z.enum(['design', 'building', 'piece']) }).passthrough()), total: count, offset: count, truncated: z.boolean() });
const shapes = new Map();
const assign = (names, schema) => { for (const name of names) shapes.set(name, schema); };
assign(['ugt_draft_building', 'ugt_draft_station', 'ugt_draft_space', 'ugt_draft_parcel_layout', 'ugt_draft_urban_rule',
    'ugt_draft_road', 'ugt_draft_track', 'ugt_modify_design', 'ugt_edit_design'], placedDesign);
assign(['ugt_draft_agreement', 'ugt_edit_agreement'], agreementDraft);
assign(['ugt_draft_plan', 'ugt_get_plan', 'ugt_edit_plan'], planResult);
assign(['ugt_inspect_shared_plan', 'ugt_edit_shared_plan'], sharedPlanSession);
const openingBucket = z.object({ floorM2: z.number().nonnegative(), spaceM2: z.number().nonnegative(), designs: count, unmeasuredBuildings: count });
const openingAssessment = z.object({ month: z.string(), delayConnection: z.boolean(),
    totals: z.object({ ready: openingBucket, blocked: openingBucket, unknown: openingBucket, later: openingBucket, all: openingBucket }),
    lostToDelay: openingBucket, readyShare: z.number().min(0).max(1).nullable(),
    members: z.array(z.object({ cid, completionMonth: z.string().nullable(),
        status: z.enum(['ready', 'blocked', 'unknown', 'later']), reason: z.string() }).passthrough()) });
const travelCategory = z.enum(['green', 'shops', 'transit']);
const travelPoint = z.tuple([z.number(), z.number()]);
const travelTitle = z.object({ title: z.string() });
const travelTrip = z.object({ seconds: count, id: z.string(), untrusted: travelTitle });
const travelHome = z.object({ id: z.string(), untrusted: travelTitle, coordinate: travelPoint.nullable(), connected: z.boolean(),
    routes: z.record(travelCategory, travelTrip.nullable()) });
const travelPlace = z.object({ id: z.string(), untrusted: travelTitle, category: travelCategory, connected: z.boolean(), coordinate: travelPoint.nullable() });
const travelRoute = z.object({ home: z.string(), category: travelCategory, trip: travelTrip.nullable(), coordinates: z.array(travelPoint).nullable() });
const walkingCounts = z.object({ destinations: count, connectedDestinations: count, within5: count, within10: count, noRoute: count.nullable() });
const walkingAssessment = z.object({ score: z.number().int().min(0).max(100).nullable(), connectedHomes: count, unstatedUse: count, pathCount: count,
    categories: z.record(travelCategory, walkingCounts), homes: z.array(travelHome), destinations: z.array(travelPlace),
    gaps: z.array(z.object({ kind: z.enum(['no-sidewalk', 'crossing-gap']), points: z.array(travelPoint) })), selectedRoute: travelRoute.optional() });
const cyclingTier = z.enum(['protected', 'painted', 'slow', 'fast', 'prohibited', 'unknown']);
const cyclingAssessment = z.object({ score: z.number().int().min(0).max(100).nullable(), connectedHomes: count, unstatedUse: count, scoredM: z.number().nonnegative(),
    lengths: z.record(cyclingTier, z.number().nonnegative()),
    categories: z.record(travelCategory, z.object({ destinations: count, reachableDestinations: count, reachableHomes: count.nullable() })),
    homes: z.array(travelHome), destinations: z.array(travelPlace.extend({ reachable: z.boolean() })),
    gaps: z.array(z.object({ kind: z.enum(['crossing-gap', 'unlinked-end']), points: z.array(travelPoint) })),
    segments: z.array(z.object({ metres: z.number().positive(), tiers: z.array(cyclingTier), points: z.tuple([travelPoint, travelPoint]) })).optional(),
    selectedRoute: travelRoute.optional() });
assign(['ugt_inspect_plan'], inventory.extend({ openingAssessment: openingAssessment.optional(), walkingAssessment: walkingAssessment.optional(), cyclingAssessment: cyclingAssessment.optional() }));
assign(['ugt_inspect_agreement'], inventory);
assign(['ugt_inspect_design'], mcpResultSchema.extend({ cid, values: z.array(z.object({ path: z.string(), untrustedValue: z.unknown() })).min(1) }));
assign(['ugt_apartment_offers'], mcpResultSchema.extend({ offers: z.array(z.object({
    cid, city: z.string(), unitId: z.string(), untrusted: z.object({ title: z.string().nullable(), label: z.string() })
})) }));
assign(['ugt_publish_plan'], mcpResultSchema.extend({ cid, untrusted: authored('plan/v1'), publication: z.literal('published'), url: z.string().url(), publishedDesignCids: z.array(cid) }));
assign(['ugt_validate_plan'], mcpResultSchema.extend({ cid, valid: z.boolean(), issues: z.array(z.object({ code: z.string(), ref: z.string() }).passthrough()), metrics: object, assessmentBasis: z.literal('authored-geometry'), sourceAssessment: object }));
assign(['ugt_capabilities'], mcpResultSchema.extend({ version: z.string(), mode: z.enum(['local', 'hosted']), endpoint: z.string().url(), workflow: z.array(z.string()).min(1), features: z.array(object), tools: z.array(z.object({ name: z.string(), title: z.string(), readOnly: z.boolean() })), drafts: z.object({ retention: z.string(), exportTool: z.literal('ugt_export_draft') }).passthrough() }));
assign(['ugt_chat_cost'], mcpResultSchema.extend({ provider: z.string(), model: z.string(), currency: z.literal('USD'),
    pricesPerMillionTokens: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative() }),
    maximumTurnReservationUsd: z.number().nonnegative(), estimate: z.object({ costUsd: z.number().nonnegative(), basis: z.literal('configured-token-prices'), actual: z.literal(false),
        tokenCounts: z.object({ inputTokens: count, outputTokens: count, cachedInputTokens: count, cacheWriteTokens: count }) }).optional() }));
assign(['ugt_help'], mcpResultSchema.extend({ topic: z.string() }));
assign(['ugt_map_view'], mcpResultSchema.extend({ view: object, parcelIdsVisible: z.boolean().optional(), roadTracksVisible: z.boolean().optional() }));
assign(['ugt_select_parcels'], mcpResultSchema.extend({ selection: z.object({ parcelSourceId: z.string(), focusParcelId: z.string().nullable(), parcelIds: z.array(z.string()).max(MAX_SOURCE_BINDING_PARCELS), active: z.boolean() }), point: z.tuple([z.number(), z.number()]).optional(), parcelNumber: z.string().optional(), location: object.optional(), candidates: z.array(object).max(3).optional() }));
assign(['ugt_list_sources'], mcpResultSchema.extend({ items: z.array(z.object({ id: z.string(), abstraction: z.string() }).passthrough()), total: count, offset: count, truncated: z.boolean(), abstractions: z.array(object) }));
assign(['ugt_export_draft'], mcpResultSchema.extend({ cid, artifact: object, publication: z.literal('private') }));
assign(['ugt_import_design'], mcpResultSchema.extend({ designs: z.array(designDraft).min(1), ...placement, publication: z.literal('private'), import: z.object({ format: z.enum(['geojson', 'osm', 'opendrive']), placement: z.string(), count: count, parser: z.string() }) }));
// A building or space model returns its private design; a furniture asset returns only the uploaded
// asset (its name arrives as untrusted prose) for a park or square to reference in decorationDesign.models.
const modelAsset = { modelUrl: z.string().url(), public: z.literal(true), durable: z.literal(true) };
const placedModel = designDraft.extend({ publication: z.literal('private'), asset: z.object({ ...modelAsset, footprint: z.literal('projected-model-triangles'), kind: z.enum(['building', 'park', 'square', 'lake']) }) });
const furnitureModel = mcpResultSchema.extend({ asset: z.object({ ...modelAsset, kind: z.literal('furniture'),
    limits: z.object({ maxTriangles: count, maxTextureSize: count, maxBytes: count, maxNameLength: count }) }).passthrough() });
assign(['ugt_import_model'], mcpResultSchema.extend({ cid: cid.optional(), asset: z.object({ ...modelAsset, kind: z.enum(['building', 'park', 'square', 'lake', 'furniture']) }).passthrough() })
    .superRefine((value, context) => {
        for (const issue of (value.asset?.kind === 'furniture' ? furnitureModel : placedModel).safeParse(value).error?.issues || [])
            context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }));
assign(['ugt_render_preview'], mcpResultSchema.extend({ ready: z.literal(true), publication: z.literal('private'), provenance: z.object({ renderer: z.enum(['app-map-preview-2d', 'app-scene-3d']), designCids: z.array(cid).min(1), persisted: z.literal(false) }), metrics: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), designCount: count }).passthrough() }));
// money: null when unknown (a measurement error says why); its amounts are null where a price or area is.
const amount = z.number().finite().nullable();
const comparedMoney = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), unit: z.literal('m2-floor'),
    prices: z.object({ sale: object.nullable(), construction: object.nullable(), land: object.nullable(), saleTax: object.nullable(), rent: object.nullable() }),
    floorAreaM2: amount, replacedFloorAreaM2: amount, landAreaM2: amount, value: amount, constructionCost: amount, landCost: amount,
    saleTax: amount, taxReclaimed: amount, replacedValue: amount, totalCost: amount, profit: amount, annualRent: amount, rentYieldOnCost: amount });
assign(['ugt_compare'], mcpResultSchema.extend({ alternatives: z.array(z.object({ cid, areaBasis: z.literal('authored-geometry'), measurementErrors: z.array(object),
    money: comparedMoney.nullable() }).passthrough()).min(2), warnings: z.array(z.union([z.string(), object])) }));

export function resultSchemaFor(name) { return shapes.get(name) || mcpResultSchema; }

export function argumentError(tool, issues = [], message = 'The tool arguments do not match its schema.') {
    return Object.assign(new Error(message), {
        code: 'invalid-arguments',
        field: issues[0]?.path?.join('.') || 'arguments',
        constraints: issues.map(issue => ({ field: issue.path?.join('.') || 'arguments', code: issue.code,
            message: issue.message, ...(issue.values ? { allowedValues: issue.values } : {}),
            ...(issue.minimum != null ? { minimum: issue.minimum } : {}), ...(issue.maximum != null ? { maximum: issue.maximum } : {}) })),
        next: { tool: 'ugt_help', arguments: { topic: tool }, action: 'Use the input schema and examples to correct the indicated fields, then retry.' }
    });
}
