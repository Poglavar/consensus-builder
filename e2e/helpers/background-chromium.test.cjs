// background-chromium.cjs: CDP Target.createTarget requests gain a background window, other messages
// pass through untouched, and a spawned --remote-debugging-pipe child receives the rewritten message.
// node:test runner. Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { enableBackgroundChromium, backgroundTarget } = require('./background-chromium.cjs');

const create = { id: 7, method: 'Target.createTarget', params: { url: 'about:blank', browserContextId: 'ctx' }, sessionId: 's' };

test('a createTarget request opens its target in the background; everything else is untouched', () => {
  assert.deepEqual(JSON.parse(backgroundTarget(JSON.stringify(create))), { ...create, params: { ...create.params, background: true, newWindow: true } });
  const explicitTab = { ...create, params: { ...create.params, newWindow: false } };
  assert.deepEqual(JSON.parse(backgroundTarget(JSON.stringify(explicitTab))), { ...explicitTab, params: { ...explicitTab.params, background: true } });
  const explicit = JSON.stringify({ ...create, params: { ...create.params, background: false } });
  assert.equal(backgroundTarget(explicit), explicit);
  const other = JSON.stringify({ id: 8, method: 'Target.closeTarget', params: { targetId: 'Target.createTarget' } });
  assert.equal(backgroundTarget(other), other);
  assert.equal(backgroundTarget('\0'), '\0');
  const buffer = Buffer.from('x');
  assert.equal(backgroundTarget(buffer), buffer);
});

test('a child spawned with --remote-debugging-pipe reads background: true from its pipe', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  enableBackgroundChromium();
  // Stands in for Chrome: reads one NUL-terminated CDP message from fd 3 and prints it.
  const echo = "let s='';require('fs').createReadStream(null,{fd:3}).on('data',(d)=>{s+=d;if(s.includes('\\0')){process.stdout.write(s.split('\\0')[0]);process.exit(0)}})";
  const child = require('node:child_process').spawn(process.execPath, ['-e', echo, '--', '--remote-debugging-pipe'], { stdio: ['ignore', 'pipe', 'inherit', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stdio[3].write(JSON.stringify(create));
  child.stdio[3].write('\0');
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(JSON.parse(out).params.background, true);
  assert.equal(JSON.parse(out).params.newWindow, true);
  assert.notEqual(spawn, require('node:child_process').spawn, 'spawn is wrapped');
});

test('headless Chrome launches leave secondary target activation unchanged', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  enableBackgroundChromium();
  const echo = "let s='';require('fs').createReadStream(null,{fd:3}).on('data',(d)=>{s+=d;if(s.includes('\\0')){process.stdout.write(s.split('\\0')[0]);process.exit(0)}})";
  for (const headlessFlag of ['--headless', '--headless=new']) {
    const child = require('node:child_process').spawn(process.execPath, ['-e', echo, '--', '--remote-debugging-pipe', headlessFlag], { stdio: ['ignore', 'pipe', 'inherit', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', data => { out += data; });
    child.stdio[3].write(JSON.stringify(create));
    child.stdio[3].write('\0');
    await new Promise(resolve => child.on('exit', resolve));
    assert.deepEqual(JSON.parse(out), create);
  }
});
