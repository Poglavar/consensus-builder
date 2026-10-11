// Keep headed Chromium test windows behind the user's active app on macOS.
// App-created popups can still activate Chrome; this covers runner-created windows only.
const path = require('node:path');

let enabled = false;
function enableBackgroundChromium() {
  if (enabled || process.platform !== 'darwin') return;
  const packagePath = require.resolve('playwright-core/package.json');
  const { version } = require(packagePath);
  // Playwright has no public option for this yet (microsoft/playwright#41306).
  // Review the adapter on upgrades instead of silently resuming focus stealing.
  if (version !== '1.58.2') throw new Error(`Review headed background window support for Playwright ${version}`);
  const { CRBrowserContext } = require(path.join(path.dirname(packagePath), 'lib/server/chromium/crBrowser.js'));
  const createPage = CRBrowserContext.prototype.doCreateNewPage;
  CRBrowserContext.prototype.doCreateNewPage = async function () {
    if (!this._browser.options.headful || this._browser.isClank()) return createPage.call(this);
    const { targetId } = await this._browser._session.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId: this._browserContextId,
      background: true,
    });
    return this._browser._crPages.get(targetId)._page;
  };
  enabled = true;
}

module.exports = { enableBackgroundChromium };
