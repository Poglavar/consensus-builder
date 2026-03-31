/**
 * Sample Zagreb parcel GeoJSON features for test mocking.
 * Coordinates are in WGS84 [lng, lat] as the API returns.
 */

export const sampleParcels = {
  type: 'FeatureCollection' as const,
  features: [
    {
      type: 'Feature' as const,
      properties: {
        parcelId: 'HR-335754-1234',
        parcel_number: '1234',
        parcel_id: 'HR-335754-1234',
        id: 'HR-335754-1234',
        cadastral_municipality: 'Trnje',
        maticni_broj_ko: '335754',
        area: 450.5,
        ownership_summary: { government: false, institution: false, company: false },
        owners: [{ name: 'Privatni vlasnik', share: '1/1' }],
      },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[
          [15.9819, 45.8000],
          [15.9825, 45.8000],
          [15.9825, 45.8005],
          [15.9819, 45.8005],
          [15.9819, 45.8000],
        ]],
      },
    },
    {
      type: 'Feature' as const,
      properties: {
        parcelId: 'HR-335754-1235',
        parcel_number: '1235',
        parcel_id: 'HR-335754-1235',
        id: 'HR-335754-1235',
        cadastral_municipality: 'Trnje',
        maticni_broj_ko: '335754',
        area: 320.0,
        ownership_summary: { government: true, institution: false, company: false },
        owners: [{ name: 'REPUBLIKA HRVATSKA', share: '1/1' }],
      },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[
          [15.9826, 45.8000],
          [15.9832, 45.8000],
          [15.9832, 45.8005],
          [15.9826, 45.8005],
          [15.9826, 45.8000],
        ]],
      },
    },
    {
      type: 'Feature' as const,
      properties: {
        parcelId: 'HR-335754-1236',
        parcel_number: '1236',
        parcel_id: 'HR-335754-1236',
        id: 'HR-335754-1236',
        cadastral_municipality: 'Trnje',
        maticni_broj_ko: '335754',
        area: 780.2,
        ownership_summary: { government: false, institution: true, company: false },
        owners: [{ name: 'CRKVA SV. MARKA', share: '1/1' }],
      },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[
          [15.9833, 45.8000],
          [15.9842, 45.8000],
          [15.9842, 45.8005],
          [15.9833, 45.8005],
          [15.9833, 45.8000],
        ]],
      },
    },
    {
      type: 'Feature' as const,
      properties: {
        parcelId: 'HR-335754-1237',
        parcel_number: '1237',
        parcel_id: 'HR-335754-1237',
        id: 'HR-335754-1237',
        cadastral_municipality: 'Trnje',
        maticni_broj_ko: '335754',
        area: 150.0,
        ownership_summary: { government: false, institution: false, company: true },
        owners: [{ name: 'FIRMA D.O.O.', share: '1/1' }],
      },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[
          [15.9843, 45.8000],
          [15.9848, 45.8000],
          [15.9848, 45.8005],
          [15.9843, 45.8005],
          [15.9843, 45.8000],
        ]],
      },
    },
    {
      type: 'Feature' as const,
      properties: {
        parcelId: 'HR-335754-1238',
        parcel_number: '1238',
        parcel_id: 'HR-335754-1238',
        id: 'HR-335754-1238',
        cadastral_municipality: 'Trnje',
        maticni_broj_ko: '335754',
        area: 2100.7,
        ownership_summary: { government: true, institution: false, company: false },
        owners: [{ name: 'GRAD ZAGREB', share: '1/1' }],
      },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[
          [15.9819, 45.8006],
          [15.9848, 45.8006],
          [15.9848, 45.8012],
          [15.9819, 45.8012],
          [15.9819, 45.8006],
        ]],
      },
    },
  ],
};

export const emptyParcels = {
  type: 'FeatureCollection' as const,
  features: [],
};
