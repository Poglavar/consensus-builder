#!/usr/bin/env node
// Launch the hosted HTTP process with a public-only environment even when PM2 inherited API secrets.
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function hostedEnvironment(env) {
    const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_ENV', 'MCP_PORT', 'MCP_PUBLIC_ORIGIN', 'MCP_PREVIEW_ORIGIN', 'MCP_DRAFT_DIRECTORY', 'UGT_API_BASE', 'UGT_APP_ORIGIN'];
    return Object.fromEntries(allowed.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./mcp-http.mjs', import.meta.url))], { env: hostedEnvironment(process.env), stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
    child.once('error', error => { console.error(`[${new Date().toISOString()}] [ugt-mcp] ${error.message}`); process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; });
}
