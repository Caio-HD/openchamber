/**
 * The autosave contract every OpenCode configuration page now shares: there is
 * no Save button, so the hook has to decide on its own when a write happens,
 * and a failure is the only thing the user is told about (as a toast).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const toastErrors: string[] = [];
mock.module('@/components/ui', () => ({
  toast: {
    error: (message: string) => { toastErrors.push(message); },
    success: () => undefined,
    info: () => undefined,
    warning: () => undefined,
  },
}));

import { I18nProvider } from '@/lib/i18n';
import {
  useAutosave,
  AUTOSAVE_SAVED,
  AUTOSAVE_UNCHANGED,
  autosaveFailed,
  type Autosave,
  type AutosaveResult,
} from './SettingsAutosave';

let window: Window;
let container: HTMLElement;
let root: Root;

beforeEach(() => {
  window = new Window({ url: 'http://localhost/' });
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    FocusEvent: window.FocusEvent,
    MouseEvent: window.MouseEvent,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  toastErrors.length = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
  window.close();
});

interface HarnessProps {
  save: () => Promise<AutosaveResult>;
  onReady: (autosave: Autosave) => void;
}

const Harness: React.FC<HarnessProps> = ({ save, onReady }) => {
  const autosave = useAutosave(save);
  onReady(autosave);
  return (
    <div onBlurCapture={autosave.onBlurCapture}>
      <input data-testid="text" />
      <button type="button" data-testid="button" />
    </div>
  );
};

const render = async (save: () => Promise<AutosaveResult>) => {
  let latest: Autosave | null = null;
  await act(async () => {
    root.render(
      <I18nProvider>
        <Harness save={save} onReady={(autosave) => { latest = autosave; }} />
      </I18nProvider>,
    );
    await Promise.resolve();
  });
  return {
    get autosave(): Autosave {
      if (!latest) throw new Error('autosave not ready');
      return latest;
    },
  };
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('useAutosave', () => {
  test('does not write until something asks it to', async () => {
    let calls = 0;
    await render(async () => { calls += 1; return AUTOSAVE_SAVED; });
    await flush();
    expect(calls).toBe(0);
    expect(container.textContent).toBe('');
  });

  test('a successful save stays silent', async () => {
    const harness = await render(async () => AUTOSAVE_SAVED);
    await act(async () => { harness.autosave.requestSave(); });
    await flush();
    expect(toastErrors).toEqual([]);
  });

  test('a save with nothing to write stays silent', async () => {
    const harness = await render(async () => AUTOSAVE_UNCHANGED);
    await act(async () => { harness.autosave.requestSave(); });
    await flush();
    expect(toastErrors).toEqual([]);
  });

  test('a refused save shows the reason', async () => {
    const harness = await render(async () => autosaveFailed('Command is required'));
    await act(async () => { harness.autosave.requestSave(); });
    await flush();
    expect(toastErrors).toHaveLength(1);
    expect(toastErrors[0]).toContain('Command is required');
  });

  test('a thrown error is reported instead of escaping the page', async () => {
    const harness = await render(async () => { throw new Error('disk is full'); });
    await act(async () => { harness.autosave.requestSave(); });
    await flush();
    expect(toastErrors[0]).toContain('disk is full');
  });

  test('leaving a text field commits, leaving a button does not', async () => {
    let calls = 0;
    await render(async () => { calls += 1; return AUTOSAVE_SAVED; });

    const input = container.querySelector('[data-testid="text"]');
    const button = container.querySelector('[data-testid="button"]');
    if (!input || !button) throw new Error('expected the harness fields');

    await act(async () => {
      button.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await flush();
    expect(calls).toBe(0);

    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await flush();
    expect(calls).toBe(1);
  });

  test('the last request decides the outcome when saves overlap', async () => {
    const pending: Array<(result: AutosaveResult) => void> = [];
    const harness = await render(() => new Promise<AutosaveResult>((resolve) => pending.push(resolve)));

    await act(async () => { harness.autosave.requestSave(); });
    await flush();
    await act(async () => { harness.autosave.requestSave(); });
    await flush();

    // The stale first save lands last and must not overwrite the newer result.
    await act(async () => { pending[1](AUTOSAVE_SAVED); });
    await flush();
    await act(async () => { pending[0](autosaveFailed('stale')); });
    await flush();

    expect(toastErrors).toEqual([]);
  });
});
