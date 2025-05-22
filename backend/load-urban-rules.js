// This script loads urban rules from pravila.js into the database.
// No need for a pool, use client.query directly.

const fs = require('fs');
const { Client } = require('pg');

const client = new Client({
    user: 'consensus',
    host: 'localhost',
    database: 'consensus',
    password: 'consensus',
    port: 5432
});

client.connect();

// Read the pravila.js file
const pravila = JSON.parse(fs.readFileSync('pravila.js', 'utf8'));

const createHash = (polygon) => {

    const crypto = require('crypto');
    return crypto.createHash('sha256').update(JSON.stringify(polygon)).digest('hex');
};

// Load the urban rules into the database
for (const pravilo of pravila) {
    const polygon = pravilo.Oblik.Lokacija;
    // For the title, we need to parse the pravilo.Data array and find this object 
    // {
    // "Label": "Oznaka",
    // "Formatting": "tekst",
    // "Value": "2.7. ",
    // "ImageData": null
    // },
    // When we find label Oznaka we need to take the value and remove the trailing dot
    // and then use it as the title
    let title = 'IZNIMKA'
    for (const data of pravilo.Data) {
        if (data.Label === "Oznaka") {
            title = data.Value.replace(/\.$/, '');
            break;
        }
    }
    const geomHash = createHash(polygon);
    const vGeom = `POLYGON((${polygon.map(l => `${l.X} ${l.Y}`).join(',')}))`;
    client.query(`INSERT INTO urban_rule (geom_hash, geom, title) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [geomHash, vGeom, title]);
}

console.log('Done');