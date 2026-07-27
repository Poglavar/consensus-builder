// The corridor definition must PERSIST its surface footprint — the footprint with tunnel spans
// excluded — alongside the `polygon` cache it already stores. It is the ground the corridor really
// clears at the surface, and therefore the ground it really BUYS: a tunnelled stretch acquires no
// parcels, so if this stops being written the road silently starts expropriating the parcels it
// merely passes underneath.
//
// It is derived through the city's metric projection (proj4 via CityConfigManager), which only the
// browser has, so a non-browser consumer cannot re-derive it. Hence this test.
//
// It is NOT what keeps a tunnelled BUILDING standing any more — a tunnel writes no demolition
// record, and the carve only ever acts on records (see corridor-carve.js).

import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Corridor surface footprint @features', () => {
  test('a tunnelled corridor persists a surface footprint that excludes the tunnelled span', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;

      // A straight 3-edge corridor. The MIDDLE edge is tunnelled.
      const lat = 45.8085;
      const nodes = [15.9740, 15.9750, 15.9760, 15.9770].map((lng) => ({ lat, lng }));
      const definition: any = {
        points: [nodes],
        segments: [nodes],
        segmentIds: ['seg-1'],
        profile: null,
        width: 12,
        sidewalkWidth: 0,
        segmentProfiles: {},
        tunnels: [],
        demolishedBuildings: [],
      };

      const union = w.buildRoadUnionPolygonForDefinition(definition);
      definition.latLngPairs = w.convertRoadPolygonToLatLngPairs(union);
      definition.polygon = w.convertLatLngPairsToGeoJSON(definition.latLngPairs);

      const turf = w.turf;
      const areaOf = (geometry: any) =>
        geometry ? turf.area({ type: 'Feature', properties: {}, geometry }) : 0;

      // With no tunnels, the corridor clears its whole polygon — nothing to store.
      w.attachCorridorSurfaceFootprint(definition);
      const withoutTunnels = definition.surfaceFootprint;

      // Now tunnel the middle edge, through the app's own record maker.
      definition.tunnels = [
        w.makeBuildingTunnelRecord(nodes[1], nodes[2], [{ id: 'building-under' }], { segmentId: 'seg-1' }),
      ];
      w.attachCorridorSurfaceFootprint(definition);

      // A point in the middle of the tunnelled edge: inside the full polygon, and it must NOT be
      // inside the surface footprint — that is the ground the road passes under.
      const overTunnel = turf.point([15.9755, lat]);
      const overSurface = turf.point([15.9745, lat]);
      const inside = (geometry: any, pt: any) =>
        !!geometry && turf.booleanPointInPolygon(pt, { type: 'Feature', properties: {}, geometry });

      return {
        withoutTunnels,
        surfaceFootprint: definition.surfaceFootprint,
        polygonArea: areaOf(definition.polygon),
        surfaceArea: areaOf(definition.surfaceFootprint),
        tunnelPointInPolygon: inside(definition.polygon, overTunnel),
        tunnelPointInSurface: inside(definition.surfaceFootprint, overTunnel),
        surfacePointInSurface: inside(definition.surfaceFootprint, overSurface),
      };
    });

    // No tunnels → nothing stored: the full polygon already IS the surface footprint.
    expect(result.withoutTunnels).toBeNull();

    // Tunnelled → a real footprint, smaller than the full polygon.
    expect(result.surfaceFootprint).toBeTruthy();
    expect(result.surfaceArea).toBeGreaterThan(0);
    expect(result.surfaceArea).toBeLessThan(result.polygonArea * 0.8);

    // The tunnelled span is inside the corridor but outside its surface footprint. This single
    // assertion is what stops the road buying the parcels it only passes under.
    expect(result.tunnelPointInPolygon).toBe(true);
    expect(result.tunnelPointInSurface).toBe(false);
    expect(result.surfacePointInSurface).toBe(true);
  });
});
