-- Create the parcel table
-- It will be used to save the parcels fetched from the source in the format:
/*
{
  "type": "Feature",
  "id": "DKP_CESTICE.13716184",
  "geometry": {
    "type": "Polygon",
    "coordinates": [
      [
        [
          499954.72,
          5080898.94
        ],
        [
          499991.85,
          5080877.2
        ],
        [
          500005.68,
          5080902.24
        ],
        [
          499901.23,
          5080963.33
        ],
        [
          499887.81,
          5080938.13
        ],
        [
          499918.09,
          5080918.72
        ],
        [
          499954.72,
          5080898.94
        ]
      ]
    ]
  },
  "geometry_name": "GEOM",
  "properties": {
    "CESTICA_ID": 13716184,
    "MATICNI_BROJ_KO": 332941,
    "BROJ_CESTICE": "1211/1",
    "IZVORNO_MJERILO": 2880,
    "GEOM": {
      "type": "Polygon",
      "coordinates": [
        [
          [
            499954.72,
            5080898.94
          ],
          [
            499991.85,
            5080877.2
          ],
          [
            500005.68,
            5080902.24
          ],
          [
            499901.23,
            5080963.33
          ],
          [
            499887.81,
            5080938.13
          ],
          [
            499918.09,
            5080918.72
          ],
          [
            499954.72,
            5080898.94
          ]
        ]
      ]
    },
    "bbox": [
      499887.81,
      5080877.2,
      500005.68,
      5080963.33
    ]
  }
}
*/

CREATE TABLE parcel (
  cestica_id INTEGER PRIMARY KEY,
  maticni_broj_ko INTEGER,
  broj_cestice VARCHAR(255),
  izvorno_mjerilo INTEGER,
  geom geometry(MultiPolygon, 3765),
  bbox geometry(Polygon, 3765)
);

-- Create a spatial index on the parcel table
CREATE INDEX parcel_geom_idx ON parcel USING GIST (geom);
