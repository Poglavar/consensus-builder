// Record real browser interactions and discovered controls; behavior assertions remain in specs.
import { BrowserContext, TestInfo } from '@playwright/test';

export type ObserveContexts = (watch: (context: BrowserContext) => void | Promise<void>) => Promise<void>;

export async function recordControlCoverage(observeContexts: ObserveContexts, testInfo: TestInfo, use: () => Promise<void>) {
  if (process.env.UI_CONTROL_COVERAGE !== '1') { await use(); return; }
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error('Control coverage requires the instrumented app baseURL');
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
    const sliderDrags = new Map<number, { slider: Element; before: string | null }>();
    const blockifyHandleDrags = new Map<number, { handle: Element; left: number; top: number }>();
    const tapTolerance = 7;
    const buttonSelector = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], a';
    const fieldSelector = 'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]), select, textarea, [role="slider"]';
    const blockifyHandleSelector = '.blockify-handle--gap, .blockify-handle--wing';
    const controlSelector = `${buttonSelector}, ${fieldSelector}, ${blockifyHandleSelector}`;
    const buttonFor = (element: Element) => {
      const control = element.closest(buttonSelector);
      if (control?.tagName === 'A' && control.getAttribute('role') !== 'button'
          && !Array.from(control.classList).some(name => /(?:^|-)(?:btn|button)(?:-|$)/.test(name) || name === 'wallet-attest-link')) return null;
      return control;
    };
    const describe = (element: Element) => {
      const blockifyHandle = element.closest(blockifyHandleSelector);
      const field = element.closest(fieldSelector);
      const button = blockifyHandle || field || buttonFor(element);
      if (!button) return null;
      // Leaflet gives every keyboard marker a button role, including explicit interactive:false
      // labels. Its leaflet-interactive class identifies live marker targets. Authored DOM handlers
      // (for example the vertex-delete marker) still have their own source identity and are kept.
      if (!button.hasAttribute('data-ui-control') && button.classList.contains('leaflet-marker-icon')
          && !button.classList.contains('leaflet-interactive')) return null;
      const attrs = Object.fromEntries(Array.from(button.attributes).filter(attr =>
        !['data-ui-native-select-boundary', 'data-ui-native-datetime-boundary'].includes(attr.name)
          && (['id', 'class', 'onclick', 'aria-label', 'title', 'name', 'type', 'value', 'role'].includes(attr.name) || attr.name.startsWith('data-'))
      ).map(attr => [attr.name, attr.value]));
      return {
        sourceIds: (button.getAttribute('data-ui-control') || '').split(' ').filter(Boolean),
        tag: button.tagName.toLowerCase(),
        label: (button.getAttribute('aria-label') || button.textContent
          || (field as HTMLInputElement | null)?.labels?.[0]?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
        attrs,
        interaction: field || blockifyHandle ? 'change' : 'click',
        controlType: blockifyHandle ? 'drag' : field ? (field.getAttribute('role') === 'slider' ? 'slider' : (field as HTMLInputElement).type || field.tagName.toLowerCase()) : 'button',
      };
    };
    const record = (kind: string, button: Element, details = {}) => {
      const control = describe(button);
      if (!control) return;
      const key = JSON.stringify(control);
      if (kind === 'observed' && known.has(key)) return;
      if (kind === 'observed') known.add(key);
      (window as any).__recordUiControl({ kind, ...control, ...details });
    };
    const discover = () => {
      for (const button of document.querySelectorAll(controlSelector)) {
        const box = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        if (box.width && box.height && style.visibility !== 'hidden' && style.pointerEvents !== 'none'
            && !(button as HTMLButtonElement).disabled && !(button as HTMLInputElement).readOnly
            && button.getAttribute('aria-disabled') !== 'true') record('observed', button);
      }
    };
    const changed = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const field = event.target.closest(fieldSelector) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
      if (!field || field.disabled || ('readOnly' in field && field.readOnly)) return;
      const isFile = field.tagName === 'INPUT' && field.type === 'file';
      const nativeSelect = event.type === 'change' && field.tagName === 'SELECT'
        && field.hasAttribute('data-ui-native-select-boundary')
        && field.getAttribute('data-ui-native-select-boundary') === field.value;
      const nativeDateTime = event.type === 'change' && field.tagName === 'INPUT' && ['date', 'datetime-local'].includes(field.type)
        && field.hasAttribute('data-ui-native-datetime-boundary')
        && field.getAttribute('data-ui-native-datetime-boundary') === field.value;
      // File selection is an operating-system boundary supplied by Playwright's file chooser.
      // Native picker selections use Locator.selectOption through the helper's exact-value
      // boundary. Arbitrary synthetic changes still cannot earn field coverage.
      if (!event.isTrusted && !nativeSelect && !nativeDateTime && !(isFile && (field as HTMLInputElement).files?.length)) return;
      const value = isFile ? Array.from((field as HTMLInputElement).files || [], file => file.name)
        : ['checkbox', 'radio'].includes(field.type) ? (field as HTMLInputElement).checked : field.value;
      record('changed', field, { value, method: isFile ? 'file-chooser-boundary'
        : nativeSelect ? 'native-select-boundary' : nativeDateTime ? 'native-datetime-boundary' : 'native-input' });
    };
    document.addEventListener('input', changed, true);
    document.addEventListener('change', changed, true);
    const recordSlider = (slider: Element, before: string | null, method: string) => {
      // Read after the real control handler has processed the same trusted user event.
      queueMicrotask(() => {
        const value = slider.getAttribute('aria-valuenow');
        if (value !== null && value !== before) record('changed', slider, { value, method });
      });
    };
    document.addEventListener('keydown', event => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const slider = event.target.closest('[role="slider"]');
      if (slider) recordSlider(slider, slider.getAttribute('aria-valuenow'), 'native-slider-key');
    }, true);
    document.addEventListener('pointerdown', event => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const blockifyHandle = event.target.closest(blockifyHandleSelector);
      if (blockifyHandle) {
        const box = blockifyHandle.getBoundingClientRect();
        blockifyHandleDrags.set(event.pointerId, { handle: blockifyHandle, left: box.left, top: box.top });
        pointerTaps.delete(event.pointerId);
        releasedTaps.delete(event.pointerId);
        return;
      }
      const slider = event.target.closest('[role="slider"]');
      if (slider) sliderDrags.set(event.pointerId, { slider, before: slider.getAttribute('aria-valuenow') });
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
      const blockifyHandleDrag = blockifyHandleDrags.get(pointerId);
      blockifyHandleDrags.delete(pointerId);
      if (blockifyHandleDrag) {
        pointerTaps.delete(pointerId);
        if (event.isTrusted) {
          const box = blockifyHandleDrag.handle.getBoundingClientRect();
          if (box.left !== blockifyHandleDrag.left || box.top !== blockifyHandleDrag.top) {
            record('changed', blockifyHandleDrag.handle, {
              value: { left: box.left, top: box.top },
              method: 'native-pointer-drag',
            });
          }
        }
        return;
      }
      const drag = sliderDrags.get(pointerId);
      sliderDrags.delete(pointerId);
      if (drag && event.isTrusted) recordSlider(drag.slider, drag.before, 'native-slider-pointer');
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
      blockifyHandleDrags.delete(event.pointerId);
      sliderDrags.delete(event.pointerId);
      pointerTaps.delete(event.pointerId);
      releasedTaps.delete(event.pointerId);
    }, true);
    document.addEventListener('click', event => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      // Gap and wing handles only respond to dragging; they have no click action.
      if (event.target.closest(blockifyHandleSelector)) return;
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
