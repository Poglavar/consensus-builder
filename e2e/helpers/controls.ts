// Operate browser-native pickers and popup lifecycles through explicit, checked interaction boundaries.
import { Locator, Page } from '@playwright/test';

/** Check and close a popup concurrently with its opener's native input acknowledgement. */
export async function openAndClosePopup(page: Page, open: () => Promise<unknown>, inspect: (popup: Page) => Promise<void>): Promise<void> {
  const opened = page.context().waitForEvent('page');
  const checked = (async () => {
    const popup = await opened;
    // Headed Chrome may hold the opener's input/navigation acknowledgement while this native
    // window remains open. Never wait for that acknowledgement before consuming the popup.
    try { await inspect(popup); }
    finally { await popup.close(); }
  })();
  await Promise.all([open(), checked]);
}

/**
 * Playwright fills the browser's date picker through a native-input boundary, like selectOption.
 * A date field takes the same boundary: typing into it follows the operating system's date order.
 */
export async function fillNativeDateTime(input: Locator, value: string): Promise<void> {
  const element = await input.elementHandle();
  if (!element) throw new Error('Native date/time input was not found');
  const marker = 'data-ui-native-datetime-boundary';
  try {
    const before = await element.evaluate((node, { marker, value }) => {
      if (!(node instanceof HTMLInputElement) || !['date', 'datetime-local'].includes(node.type)) {
        throw new Error('Expected a native date or datetime-local input');
      }
      if (node.disabled || node.readOnly) throw new Error('Native date/time input is not editable');
      const before = node.value;
      if (before !== value) node.setAttribute(marker, value);
      return before;
    }, { marker, value });
    if (before === value) return;
    await input.fill(value);
    if (await input.inputValue() !== value) throw new Error(`Native date/time input did not accept ${value}`);
  } finally {
    await element.evaluate((node, marker) => node.removeAttribute(marker), marker);
    await element.dispose();
  }
}

export type NativeSelectOption = string | { label: string } | { value: string };

export interface NativeSelectResult {
  method: 'native-select-boundary';
  selectedValues: string[];
  changeValue: string | null;
}

/** Select a native option through Playwright's explicitly marked native-picker boundary. */
export async function selectNativeOption(select: Locator, option: NativeSelectOption): Promise<NativeSelectResult> {
  const state = await select.evaluate((element, requestedValue) => {
    if (!(element instanceof HTMLSelectElement)) throw new Error('Expected a native <select> element');
    const options = Array.from(element.options).map((option, index) => ({
      index,
      value: option.value,
      label: option.label,
      disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
    }));
    return {
      selectedIndex: element.selectedIndex,
      enabled: options.filter(option => !option.disabled),
      target: options.find(option => typeof requestedValue === 'string'
        ? option.value === requestedValue
        : 'label' in requestedValue ? option.label === requestedValue.label : option.value === requestedValue.value) || null,
    };
  }, option);
  const description = typeof option === 'string' ? option : 'label' in option ? `label ${JSON.stringify(option.label)}` : `value ${JSON.stringify(option.value)}`;
  if (!state.target) throw new Error(`No native select option has ${description}`);
  if (state.target.disabled) throw new Error(`Native select option with ${description} is disabled`);
  if (!state.enabled.some(candidate => candidate.index === state.target!.index)) {
    throw new Error(`Native select option with ${description} is unavailable`);
  }

  const method: NativeSelectResult['method'] = 'native-select-boundary';
  const currentValue = await select.inputValue();
  if (currentValue === state.target.value) return { method, selectedValues: [], changeValue: null };

  const recorderKey = `__nativeSelectEvents_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await select.evaluate((element, key) => {
    const events: Array<{ type: string; value: string; isTrusted: boolean }> = [];
    const record = (event: Event) => events.push({
      type: event.type,
      value: (element as HTMLSelectElement).value,
      isTrusted: event.isTrusted,
    });
    element.addEventListener('input', record, true);
    element.addEventListener('change', record, true);
    (window as any)[key] = { element, events, record };
  }, recorderKey);

  let selectedValues: string[] = [];
  let events: Array<{ type: string; value: string; isTrusted: boolean }> = [];
  const marker = 'data-ui-native-select-boundary';
  try {
    await select.page().evaluate(({ key, markerName, value }) => {
      const recorder = (window as any)[key];
      if (!recorder) throw new Error('Native select event recorder was not installed');
      recorder.element.setAttribute(markerName, value);
    }, { key: recorderKey, markerName: marker, value: state.target.value });
    selectedValues = await select.selectOption({ value: state.target.value });
  } finally {
    events = await select.page().evaluate(({ key, markerName }) => {
      const recorder = (window as any)[key];
      if (!recorder) return [];
      recorder.element.removeAttribute(markerName);
      recorder.element.removeEventListener('input', recorder.record, true);
      recorder.element.removeEventListener('change', recorder.record, true);
      delete (window as any)[key];
      return recorder.events;
    }, { key: recorderKey, markerName: marker });
  }

  const changeValue = events.find(event => event.type === 'change' && event.value === state.target!.value)?.value ?? null;
  if (currentValue !== state.target.value && changeValue !== state.target.value) {
    throw new Error(`Native select did not change to ${JSON.stringify(state.target.value)} via ${method}; observed ${JSON.stringify(events)}`);
  }
  if (!selectedValues.length && changeValue === state.target.value) selectedValues = [state.target.value];

  return { method, selectedValues, changeValue };
}
