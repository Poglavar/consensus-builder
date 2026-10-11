// Record trusted browser interactions and discovered buttons; passing assertions remain in specs.
import { BrowserContext, TestInfo } from '@playwright/test';

export type ObserveContexts = (watch: (context: BrowserContext) => void | Promise<void>) => Promise<void>;

export async function recordControlCoverage(observeContexts: ObserveContexts, testInfo: TestInfo, use: () => Promise<void>) {
  if (process.env.UI_CONTROL_COVERAGE !== '1') { await use(); return; }
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error('Button coverage requires the instrumented app baseURL');
  const appOrigin = new URL(baseURL).origin;
  const events: any[] = [];
  await observeContexts(async context => {
    await context.exposeBinding('__recordUiControl', ({ page }, event) => events.push({ ...event, url: page.url() }));
    await context.addInitScript(appOrigin => {
    // Explorer, wallet and sharing popups can navigate to another product. Those pages' buttons
    // are outside this app's inventory; the originating action is still recorded and asserted.
    if (location.origin !== appOrigin) return;
    const known = new Set<string>();
    const pointerTaps = new Map<number, { button: Element; x: number; y: number }>();
    const releasedTaps = new Map<number, { button: Element; x: number; y: number; expires: number }>();
    const tapTolerance = 7;
    const controlSelector = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], a';
    const buttonFor = (element: Element) => {
      const control = element.closest(controlSelector);
      if (control?.tagName === 'A' && control.getAttribute('role') !== 'button'
          && !Array.from(control.classList).some(name => /(?:^|-)(?:btn|button)(?:-|$)/.test(name) || name === 'wallet-attest-link')) return null;
      return control;
    };
    const describe = (element: Element) => {
      const button = buttonFor(element);
      if (!button) return null;
      // Leaflet gives every keyboard marker a button role, including explicit interactive:false
      // labels. Its leaflet-interactive class identifies live marker targets. Authored DOM handlers
      // (for example the vertex-delete marker) still have their own source identity and are kept.
      if (!button.hasAttribute('data-ui-control') && button.classList.contains('leaflet-marker-icon')
          && !button.classList.contains('leaflet-interactive')) return null;
      const attrs = Object.fromEntries(Array.from(button.attributes).filter(attr =>
        ['id', 'class', 'onclick', 'aria-label', 'title', 'name', 'type', 'value', 'role'].includes(attr.name) || attr.name.startsWith('data-')
      ).map(attr => [attr.name, attr.value]));
      return {
        sourceIds: (button.getAttribute('data-ui-control') || '').split(' ').filter(Boolean),
        tag: button.tagName.toLowerCase(),
        label: (button.getAttribute('aria-label') || button.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
        attrs,
      };
    };
    const record = (kind: string, button: Element) => {
      const control = describe(button);
      if (!control) return;
      const key = JSON.stringify(control);
      if (kind === 'observed' && known.has(key)) return;
      if (kind === 'observed') known.add(key);
      (window as any).__recordUiControl({ kind, ...control });
    };
    const discover = () => {
      for (const button of document.querySelectorAll(controlSelector)) {
        const box = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        if (box.width && box.height && style.visibility !== 'hidden' && style.pointerEvents !== 'none'
            && !(button as HTMLButtonElement).disabled && button.getAttribute('aria-disabled') !== 'true') record('observed', button);
      }
    };
    document.addEventListener('pointerdown', event => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const button = buttonFor(event.target);
      if (!button || !describe(button)) return;
      const pointerId = event.pointerId;
      pointerTaps.set(pointerId, { button, x: event.clientX, y: event.clientY });
      releasedTaps.delete(pointerId);
    }, true);
    document.addEventListener('pointermove', event => {
      const pointerId = event.pointerId;
      const tap = pointerTaps.get(pointerId);
      if (!tap) return;
      if (!event.isTrusted || Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > tapTolerance) {
        pointerTaps.delete(pointerId);
      }
    }, true);
    document.addEventListener('pointerup', event => {
      const pointerId = event.pointerId;
      const tap = pointerTaps.get(pointerId);
      pointerTaps.delete(pointerId);
      if (!tap || !event.isTrusted || Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > tapTolerance) return;
      const released = { ...tap, expires: event.timeStamp + 250 };
      releasedTaps.set(pointerId, released);
      setTimeout(() => {
        if (releasedTaps.get(pointerId) === released) releasedTaps.delete(pointerId);
      }, 250);
    }, true);
    document.addEventListener('pointercancel', event => {
      pointerTaps.delete(event.pointerId);
      releasedTaps.delete(event.pointerId);
    }, true);
    document.addEventListener('click', event => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      // Pointer-generated clicks on a renderer canvas retain the pointer ID but lose the DOM
      // button as their target. Attribute one only to the source button whose trusted down/up
      // formed this tap; a missing/invalid candidate must not fall back to the canvas target.
      const pointerId = (event as PointerEvent).pointerId;
      if (typeof pointerId === 'number' && pointerId >= 0) {
        const tap = releasedTaps.get(pointerId);
        releasedTaps.delete(pointerId);
        if (tap && event.timeStamp <= tap.expires
            && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) <= tapTolerance) {
          record('clicked', tap.button);
        }
        return;
      }
      // Keyboard activation has no physical pointer ID, so its trusted click remains a normal
      // direct interaction with the button.
      record('clicked', event.target);
    }, true);
    const watch = () => {
      discover();
      new MutationObserver(discover).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-expanded', 'role'] });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, { once: true });
    else watch();
    }, appOrigin);
  });
  await use();
  await testInfo.attach('ui-control-coverage', { contentType: 'application/json', body: Buffer.from(JSON.stringify(events)) });
}
