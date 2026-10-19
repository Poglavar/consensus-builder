// Characterize GUP translation refusals and native proposal/measurement round trips.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { classifyParcel, translateParcel, summarizeAudits } from '../gup-restatement/translate.js';
import { parseArgs, PAGE_SQL, verifyProposalReadBack } from '../scripts/build-gup-restatement.mjs';
import { serializeProposalRow } from '../proposals/serializer.js';
const require = createRequire(import.meta.url);
const variation = require('../../frontend/js/urban-rule-variation.js');
const yieldModel = require('../../frontend/js/proposals/plan-yield.js');

function row(overrides = {}) {
    const geometry = turf.bboxPolygon([16, 45.8, 16.0001, 45.8001]).geometry;
    const area = turf.area({ type: 'Feature', geometry, properties: {} });
    const floors = [0, 1, 2, 3].map(index => ({ level: index + 1, area_m2: area,
        height_m: 3, base_elevation_m: index * 3, top_elevation_m: (index + 1) * 3,
        is_half_floor: false, geometry: structuredClone(geometry) }));
    return { cestica_id: 1, parcel_id: 'HR-123456-10/1', cache_present: true,
        identity_matches: true, geometry_matches: true, zone: '2.9', rule_id: '2.9-residential',
        planned_use_mark: 'M1', solver_version: 'v44', computed_at: '2026-10-01T00:00:00Z',
        result_status: 'geometry_validated', geometry_status: 'passed', build_regime: 'new_build',
        buildable: true, source: 'rule', applicability_status: 'unresolved',
        gbp_m2: area * 4, footprint_area_m2: area, total_height_m: 12,
        floors_count: 4, max_units: 3, floors, variables: { min_etage: 4, max_kisn: 2 },
        footprint_geometry: geometry, footprint_valid: true, outside_m2: 0,
        parcel_geometry: turf.bboxPolygon([15.9999, 45.7999, 16.0002, 45.8002]).geometry,
        scope_area_m2: 780, existing_gbp: 120, existing_gbp_status: 'measured',
        ...overrides };
}

describe('GUP spatial restatement', () => {
    it('exports a native range rule with pinned source, while retaining unresolved applicability', () => {
        const input = row(), before = structuredClone(input);
        const { proposal, audit } = translateParcel(input);
        expect(input).toEqual(before);
        expect(audit.status).toBe('represented');
        expect(audit.flags).toContain('source_applicability_unresolved');
        expect(audit.flags).toContain('scalar_limits_retained_as_source_notes');
        expect(proposal.buildingProposal.parameters.rule).toMatchObject({ kind: 'range', minHeightM: 12, maxHeightM: 12 });
        expect(proposal.buildingProposal.parameters.mode).toBe('manual');
        expect(proposal.buildingProposal.parameters.width).toBeGreaterThan(20);
        expect(proposal.cadastreParcelIds).toEqual([input.parcel_id]);
        expect(proposal.geometry.buildings[0].properties).not.toHaveProperty('parcelId');
        const stored = { id: 1, proposal_id: proposal.proposalId, cadastre_parcel_ids: proposal.cadastreParcelIds,
            proposal_data: proposal, building_proposal: proposal.buildingProposal };
        const decoded = serializeProposalRow(stored);
        expect(decoded.geometry.buildings).toEqual(proposal.geometry.buildings);
        const measured = yieldModel.measureBuilding(decoded.geometry.buildings[0], decoded.buildingProposal);
        expect(measured.gfaM2).toBeCloseTo(input.gbp_m2, 0);
        expect(decoded.buildingProposal.parameters.gupRestatement.maxUnits).toBe(3);
        expect(translateParcel(input).proposal.proposalId).toBe(proposal.proposalId);
    });

    it('keeps the ordinary max rule optional, rather than exact compulsory construction', () => {
        const proposal = translateParcel(row({ variables: {} })).proposal;
        const feature = proposal.geometry.buildings[0];
        expect(feature.properties.urbanRule.kind).toBe('max');
        const realized = variation.realizeFeature(feature, { turf });
        expect(realized.properties.height).toBeLessThanOrEqual(feature.properties.height);
    });

    it('does not convert an unsuccessful candidate search, missing cache or empirical stock into zero', () => {
        for (const changes of [{ cache_present: false }, { result_status: 'no_validated_candidate', buildable: false },
            { source: 'empirical', result_status: 'existing_stock_estimate', build_regime: 'reconstruction' }]) {
            const { audit, proposal } = translateParcel(row(changes));
            expect(proposal).toBeNull(); expect(audit.status).toBe('skipped');
            expect(audit.newBuildCapacityM2).toBeNull();
            expect(audit.existingStock.gbpM2).toBe(120);
        }
    });

    it('records proven zero separately without creating a demolition proposal', () => {
        const result = translateParcel(row({ gbp_m2: 0, zero_capacity_bound: true, buildable: false }));
        expect(result.audit.status).toBe('proven_zero');
        expect(result.audit.newBuildCapacityM2).toBe(0);
        expect(result.proposal).toBeNull();
    });

    it.each([
        [{ identity_matches: false }, 'source_identity'],
        [{ geometry_matches: false }, 'source_identity'],
        [{ outside_m2: 1 }, 'source_geometry'],
        [{ total_height_m: null }, 'source_unknown'],
        [{ zone: '1.4' }, 'unsupported_mandatory_form'],
        [{ zone: '2.9.1' }, 'unsupported_mandatory_form'],
        [{ gbp_m2: 99999 }, 'source_quantity_mismatch']
    ])('refuses an unrepresentable or ungrounded input %j', (changes, reason) => {
        const result = translateParcel(row(changes));
        expect(result.proposal).toBeNull(); expect(result.audit.reasons).toContain(reason);
    });

    it('refuses a recessed floor instead of extruding its larger ground footprint to the top', () => {
        const input = row(); input.floors[3].is_half_floor = true;
        input.floors[3].area_m2 *= 0.75;
        expect(translateParcel(input).audit.reasons).toContain('unsupported_floor_profile');
        expect(translateParcel(input).proposal).toBeNull();
    });

    it('refuses a hole or multipart outline rather than silently dropping it in the editor', () => {
        const input = row();
        input.footprint_geometry.coordinates.push(turf.bboxPolygon([16.00002,45.80002,16.00003,45.80003]).geometry.coordinates[0]);
        expect(translateParcel(input).audit.reasons).toContain('unsupported_footprint_topology');
    });

    it('has an explicit strict mode for binding scalar limits the app cannot enforce', () => {
        expect(classifyParcel(row(), { strictScalars: true }).reasons).toContain('unsupported_scalar_rule');
        expect(translateParcel(row(), { strictScalars: true }).proposal).toBeNull();
    });

    it('counts every parcel once while accounting for multiple reasons and absent area independently', () => {
        const audits = [translateParcel(row()).audit, translateParcel(row({ cache_present: false, scope_area_m2: null })).audit,
            translateParcel(row({ gbp_m2: 0, zero_capacity_bound: true })).audit];
        const summary = summarizeAudits(audits);
        expect(summary).toMatchObject({ parcels: 3, represented: 1, skipped: 1, proven_zero: 1, missingAreaParcels: 1 });
        expect(summary.representedAreaM2).toBe(780);
        expect(summary.zones['2.9'].parcels).toBe(3);
    });

    it('does not mutate stored massing when the existing view generates a realization', () => {
        const proposal = translateParcel(row({ variables: {} })).proposal;
        const before = structuredClone(proposal);
        variation.realizeFeature(proposal.geometry.buildings[0], { turf });
        expect(proposal).toEqual(before);
    });

    it('requires explicit build/apply and includes uncached current parcels in the source cohort', () => {
        expect(parseArgs([]).build).toBeUndefined();
        expect(() => parseArgs(['--build','--apply'])).toThrow();
        expect(() => parseArgs(['--batch-size','0'])).toThrow();
        expect(PAGE_SQL).toContain('LEFT JOIN public.parcel_build_envelope');
        expect(PAGE_SQL).toContain('FROM public.parcel p');
    });

    it('verifies JSONB read-back independent of object key order, and refuses changed content', () => {
        const proposal = translateParcel(row()).proposal;
        const stored = { proposal_data: Object.fromEntries(Object.entries(proposal).reverse()),
            cadastre_parcel_ids: proposal.cadastreParcelIds, building_proposal: proposal.buildingProposal };
        expect(verifyProposalReadBack(stored, proposal).geometry.buildings).toEqual(proposal.geometry.buildings);
        stored.proposal_data = { ...stored.proposal_data, name: 'changed' };
        expect(() => verifyProposalReadBack(stored, proposal)).toThrow('Read-back differs');
    });
});
