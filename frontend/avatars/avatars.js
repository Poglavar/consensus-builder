// avatars.js
// Node.js script to slice heads.png (4x4 grid, 1024x1024) into 16 avatar PNGs (avatar1.png to avatar16.png)
// Usage: node avatars.js

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const INPUT_FILE = path.join(__dirname, 'frontend', 'heads.png');
const OUTPUT_DIR = path.join(__dirname, 'frontend');
const GRID_SIZE = 4;
const CELL_SIZE = 256; // 1024 / 4

async function sliceAvatars() {
    if (!fs.existsSync(INPUT_FILE)) {
        console.error('heads.png not found in frontend/');
        process.exit(1);
    }
    for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
        const row = Math.floor(i / GRID_SIZE);
        const col = i % GRID_SIZE;
        const left = col * CELL_SIZE;
        const top = row * CELL_SIZE;
        const outputFile = path.join(OUTPUT_DIR, `avatar${i + 1}.png`);
        await sharp(INPUT_FILE)
            .extract({ left, top, width: CELL_SIZE, height: CELL_SIZE })
            .toFile(outputFile);
        console.log(`Created ${outputFile}`);
    }
    console.log('All avatars created!');
}

sliceAvatars().catch(err => {
    console.error('Error:', err);
    process.exit(1);
}); 