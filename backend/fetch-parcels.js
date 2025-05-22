/*
  Fetch parcels from the online database.
  Save them to the local database.
  The parcels are saved in the parcels table in PostgreSQL / PostGIS.
  The parcels are fetched from the same source as the parcels in the fetchParcelDataFrontend().
  We start approximately from the centre of the ciry of Zagreb and we get parcels for
  a 1 km x 1 km square. We then go to the next square, 1 km away from the previous one,
  to the right. We continue this movement in a sort ofspiral until we stop the execution
  of the script or get all parcels in Croatia.
  Parcels should be unique in the database. If the script is rerun, it will upsert
  the parcels in the database (update if they already exist, insert if they don't).
*/

const { Client } = require('pg');
const fs = require('fs');
// load the .env file
require('dotenv').config();

const CROATIA_AREA_KM2 = 56594;
const CHUNK_AREA_KM2 = 1; // Each chunk is 1km x 1km

async function fetchOneChunk(x, y) {
    console.log('fetchOneChunk called');
    // Center of Zagreb in HTRS96/TM (EPSG:3765):
    // Example: Easting: 500000, Northing: 5080000 (approximate)
    // const center = { easting: 500000, northing: 5080000 };
    const center = { easting: 457422, northing: 5068783 };

    const gridSize = 1000; // 1 km

    try {
        // Calculate SW and NE corners in HTRS96/TM
        const swEasting = center.easting + x * gridSize;
        const swNorthing = center.northing + y * gridSize;
        const neEasting = center.easting + (x + 1) * gridSize;
        const neNorthing = center.northing + (y + 1) * gridSize;
        const bbox = `${swEasting},${swNorthing},${neEasting},${neNorthing}`;
        console.log(bbox);

        const token = '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';
        const baseUrl = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
        const url = `${baseUrl}?${new URLSearchParams({
            token: token,
            service: 'WFS',
            version: '1.0.0',
            request: 'GetFeature',
            maxFeatures: '2000',
            outputFormat: 'json',
            typeName: 'oss:DKP_CESTICE',
            srsName: 'EPSG:3765',
            bbox: bbox
        }).toString()}`;

        let data;
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error('Failed to fetch parcel data');
            data = await response.json();
        } catch (error) {
            console.error('Error fetching parcel data:', error);
            console.log(response);
        }
        // console.log(data);
        console.log(data.features.length);

        return data.features;
    } catch (error) {
        console.error('Error fetching parcel data:', error);
    }
}

/*
  Fetch the parcels from the source for the first chunk which is a 1 km x 1 km square
  with the center at the city center (in HTRS96/TM coordinates). This function will call the fetching function
  once for each chunk and make sure chunks are visited in a spiral movement.

  The spiral movement means that we move clockwise: right, down, left, up, always trying to visit the next unvisited chunk.
  We keep track of the chunks that have already been fetched using a Set, where each chunk is identified by a string key 'x,y'.
  This ensures that each 1x1 km chunk is only fetched once, and avoids issues with negative or large coordinates.

  The spiral continues until there are no more unvisited neighbors or no new parcels are fetched.
*/
const fetchParcelsFromSource = async () => {
    const parcels = [];
    // Do NOT declare let processedChunks before this
    const chunksPath = __dirname + '/chunks.js';
    if (fs.existsSync(chunksPath)) {
        const content = fs.readFileSync(chunksPath, 'utf8');
        try {
            eval(content); // This will define processedChunks in the current scope
        } catch (e) {
            console.error('Failed to load processedChunks from chunks.js:', e);
        }
    }
    if (typeof processedChunks === 'undefined' || !Array.isArray(processedChunks)) {
        processedChunks = [];
    }
    console.log('Starting fetchParcelsFromSource, processedChunks:', processedChunks.length);
    const fetchedChunks = new Set(processedChunks.map(chunk => `${chunk.x},${chunk.y}`));
    const moves = [
        { dx: 1, dy: 0 },  // right
        { dx: 0, dy: 1 },  // down
        { dx: -1, dy: 0 }, // left
        { dx: 0, dy: -1 }  // up
    ];
    let x, y;
    if (processedChunks.length > 0) {
        x = processedChunks[processedChunks.length - 1].x;
        y = processedChunks[processedChunks.length - 1].y;
        console.log('Resuming from last chunk:', x, y);
    } else {
        x = 0;
        y = 0;
        console.log('Starting from (0,0)');
    }
    let dir = 0; // start moving right
    let newParcels;
    let chunkCount = processedChunks.length;
    do {
        console.log('Current chunk:', x, y, 'Already fetched:', fetchedChunks.has(`${x},${y}`));
        if (fetchedChunks.has(`${x},${y}`)) {
            // Already fetched, skip
            // Spiral logic below will move to next chunk
        } else {
            newParcels = await fetchOneChunk(x, y);
            if (newParcels && newParcels.length) {
                parcels.push(...newParcels);
            }
            fetchedChunks.add(`${x},${y}`);
            processedChunks.push({ x, y });
            chunkCount++;
            console.log('chunkCount:', chunkCount);
            // Output statistics every 100 chunks
            if (chunkCount % 100 === 0) {
                const area = chunkCount * CHUNK_AREA_KM2;
                const percent = Math.round((area / CROATIA_AREA_KM2) * 100);
                const side = Math.round(Math.sqrt(area));
                console.log(`Chunks: ${chunkCount}, Parcels: ${parcels.length}, Area: ${area} km2, Percent of Croatia: ${percent}%, Square side: ${side} km`);
            }
            await saveParcelsToDatabase(newParcels);
            // Write the processedChunks array to chunks.js as a JS variable
            fs.writeFileSync(
                __dirname + '/chunks.js',
                'var processedChunks = ' + JSON.stringify(processedChunks, null, 2) + ';'
            );
        }
        // Spiral logic: always try to turn right first
        let nextDir = (dir + 1) % 4;
        let nx = x + moves[nextDir].dx;
        let ny = y + moves[nextDir].dy;
        if (!fetchedChunks.has(`${nx},${ny}`)) {
            // Turn right
            x = nx;
            y = ny;
            dir = nextDir;
        } else {
            // Try to go straight
            nx = x + moves[dir].dx;
            ny = y + moves[dir].dy;
            if (!fetchedChunks.has(`${nx},${ny}`)) {
                x = nx;
                y = ny;
                // dir stays the same
            } else {
                // Try all other directions (rare, for blocked cases)
                let found = false;
                for (let i = 2; i < 4; i++) {
                    nextDir = (dir + i) % 4;
                    nx = x + moves[nextDir].dx;
                    ny = y + moves[nextDir].dy;
                    if (!fetchedChunks.has(`${nx},${ny}`)) {
                        x = nx;
                        y = ny;
                        dir = nextDir;
                        found = true;
                        break;
                    }
                }
                if (!found) break; // No unvisited neighbors
            }
        }
        if (chunkCount >= 31000) break;
        // Croatia has a very irregular shape, so we must not stop the execution when
        // we got no parcels in the last chunk. We must carry on until we have moved
        // a total of 100 km in any direction. Using r2Pi we got how many chunks.
    } while (true);

    return parcels;
};

function toMultiPolygon(geometry) {
    if (!geometry) return null;
    if (geometry.type === 'Polygon') {
        return {
            type: 'MultiPolygon',
            coordinates: [geometry.coordinates]
        };
    }
    return geometry;
}

const saveParcelsToDatabase = async (parcels) => {
    // save the parcels to the database using the parcels table defined in db/parcels.sql
    // we need to convert the parcels to the format defined in the parcels table
    const parcelsToSave = parcels.map(parcel => ({
        cestica_id: parcel.properties.CESTICA_ID,
        maticni_broj_ko: parcel.properties.MATICNI_BROJ_KO,
        broj_cestice: parcel.properties.BROJ_CESTICE,
        izvorno_mjerilo: parcel.properties.IZVORNO_MJERILO,
        geom: toMultiPolygon(parcel.geometry),
        bbox: parcel.bbox
    }));
    // save the parcels to the database
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });
    await client.connect();
    for (const parcel of parcelsToSave) {
        await client.query(
            `INSERT INTO parcels (cestica_id, maticni_broj_ko, broj_cestice, izvorno_mjerilo, geom, bbox)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (cestica_id) DO UPDATE SET
               maticni_broj_ko = EXCLUDED.maticni_broj_ko,
               broj_cestice = EXCLUDED.broj_cestice,
               izvorno_mjerilo = EXCLUDED.izvorno_mjerilo,
               geom = EXCLUDED.geom,
               bbox = EXCLUDED.bbox`,
            [
                parcel.cestica_id,
                parcel.maticni_broj_ko,
                parcel.broj_cestice,
                parcel.izvorno_mjerilo,
                parcel.geom,
                parcel.bbox
            ]
        );
    }
    await client.end();
    return parcelsToSave;
};

const fetchParcels = async () => {
    const parcels = await fetchParcelsFromSource();
};

fetchParcels();





