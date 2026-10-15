// Keep headed Chromium windows behind the user's active app on macOS. Every page Playwright (or
// Puppeteer with pipe: true) opens is a CDP Target.createTarget sent down Chrome's
// --remote-debugging-pipe; this adds background: true to those requests. It hooks only Node's
// child_process.spawn and the pipe's message framing (JSON + NUL), so it works on any Playwright
// version. Each managed page gets its own background window: inactive tabs in an existing window
// can stall CDP commands even with background throttling disabled. Windows Chrome opens by itself
// (a persistent context's startup window, app popups) are
// not covered. Based on agents/lib/background-chromium, with headless launches left untouched:
// background targets in headless Chrome stall secondary tabs despite the anti-throttling flags.
const childProcess = require('node:child_process');

const PATCHED = Symbol.for('background-chromium.patched');

// One CDP message as written to the pipe -> the same message, opening its target in the background.
function backgroundTarget(chunk) {
  if (typeof chunk !== 'string' || !chunk.includes('"Target.createTarget"')) return chunk;
  const message = JSON.parse(chunk);
  if (message.method !== 'Target.createTarget' || message.params?.background !== undefined) return chunk;
  return JSON.stringify({ ...message, params: { ...message.params, background: true, newWindow: message.params?.newWindow ?? true } });
}

function enableBackgroundChromium() {
  if (process.platform !== 'darwin' || process.env.BACKGROUND_CHROMIUM === '0' || childProcess[PATCHED]) return;
  const spawn = childProcess.spawn;
  childProcess.spawn = function (command, args, ...rest) {
    const child = spawn.call(this, command, args, ...rest);
    const headless = Array.isArray(args) && args.some(arg => /^--headless(?:=|$)/.test(arg));
    const pipe = !headless && Array.isArray(args) && args.includes('--remote-debugging-pipe') ? child.stdio?.[3] : null;
    if (pipe) {
      const write = pipe.write;
      pipe.write = function (chunk, ...more) { return write.call(this, backgroundTarget(chunk), ...more); };
    }
    return child;
  };
  childProcess[PATCHED] = true;
}

module.exports = { enableBackgroundChromium, backgroundTarget };
