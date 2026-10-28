import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const frontendRoot = fileURLToPath(new URL('../../../frontend/', import.meta.url));

export function readMapModeLoader() {
    return readFileSync(`${frontendRoot}/js/map-mode-loader.js`, 'utf8');
}

// The model group's script paths in load order, without their ?v= cache tokens. A `...name` entry is
// a shared list declared in the loader as `const name = [...]` (the floor-plan modules) and is expanded.
export function mapModeModelScripts() {
    const source = readMapModeLoader();
    const match = source.match(/model:\s*\[([\s\S]*?)\],\s*photo:/);
    if (!match) throw new Error('Could not find the model script group in map-mode-loader.js');
    const paths = text => [...text.matchAll(/'([^']+)'/g)].map(([, path]) => path.split('?')[0]);
    return [...match[1].matchAll(/\.\.\.([A-Za-z_$][\w$]*)|'([^']+)'/g)].flatMap(([, spread, path]) => {
        if (!spread) return [path.split('?')[0]];
        const list = source.match(new RegExp(`const ${spread} = \\[([\\s\\S]*?)\\];`));
        if (!list) throw new Error(`Could not find the ${spread} list spread into the model group`);
        return paths(list[1]);
    });
}

export function readFrontendIndex() {
    return readFileSync(`${frontendRoot}/index.html`, 'utf8');
}
