// Keep headed Chromium windows behind the user's active app on macOS. Every page Playwright (or
// Puppeteer with pipe: true) opens is a CDP Target.createTarget sent down Chrome's
// --remote-debugging-pipe; this adds background: true to those requests. It hooks only Node's
// child_process.spawn and the pipe's message framing (JSON + NUL), so it works on any Playwright
// version. Windows Chrome opens by itself (a persistent context's startup window, app popups) are
// not covered. Canonical copy: agents/lib/background-chromium; repos carry identical copies.
const childProcess = require('node:child_process');

const PATCHED = Symbol.for('background-chromium.patched');

// One CDP message as written to the pipe -> the same message, opening its target in the background.
function backgroundTarget(chunk) {
  if (typeof chunk !== 'string' || !chunk.includes('"Target.createTarget"')) return chunk;
  const message = JSON.parse(chunk);
  if (message.method !== 'Target.createTarget' || message.params?.background !== undefined) return chunk;
  return JSON.stringify({ ...message, params: { ...message.params, background: true } });
}

function enableBackgroundChromium() {
  if (process.platform !== 'darwin' || process.env.BACKGROUND_CHROMIUM === '0' || childProcess[PATCHED]) return;
  const spawn = childProcess.spawn;
  childProcess.spawn = function (command, args, ...rest) {
    const child = spawn.call(this, command, args, ...rest);
    const pipe = Array.isArray(args) && args.includes('--remote-debugging-pipe') ? child.stdio?.[3] : null;
    if (pipe) {
      const write = pipe.write;
      pipe.write = function (chunk, ...more) { return write.call(this, backgroundTarget(chunk), ...more); };
    }
    return child;
  };
  childProcess[PATCHED] = true;
}

module.exports = { enableBackgroundChromium, backgroundTarget };
