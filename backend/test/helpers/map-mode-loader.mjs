import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const frontendRoot = fileURLToPath(new URL('../../../frontend/', import.meta.url));

export function readMapModeLoader() {
    return readFileSync(`${frontendRoot}/js/map-mode-loader.js`, 'utf8');
}

export function mapModeModelScripts() {
    const source = readMapModeLoader();
    const match = source.match(/model:\s*\[([\s\S]*?)\],\s*photo:/);
    if (!match) throw new Error('Could not find the model script group in map-mode-loader.js');
    return [...match[1].matchAll(/'([^']+)'/g)].map(([, path]) => path);
}

export function readFrontendIndex() {
    return readFileSync(`${frontendRoot}/index.html`, 'utf8');
}
