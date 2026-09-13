import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

/**
 * Autosave for the OpenCode configuration pages (agents, commands, skills,
 * MCP, plugins, behavior).
 *
 * OpenCode v2 watches its own config files and applies changes within a second
 * or two, so these pages have no Save or Apply button. Toggles, selects and
 * pickers call `requestSave()` right after the state update; text fields are
 * committed by `onBlurCapture` on the page container (and by Cmd/Ctrl+Enter
 * where an editor supports it). Success is silent; a failed write is reported
 * with an error toast. There is no inline indicator: the write is not
 * something the user waits for.
 */

export type AutosaveResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: string };

/** Nothing to write — the form matches the last successful save. */
export const AUTOSAVE_UNCHANGED: AutosaveResult = { ok: true, changed: false };
/** Written. */
export const AUTOSAVE_SAVED: AutosaveResult = { ok: true, changed: true };
/** Refused or failed; the reason is shown to the user verbatim. */
export const autosaveFailed = (reason: string): AutosaveResult => ({ ok: false, reason });

export interface Autosave {
  /**
   * Save after the current render commits, so the routine reads the state the
   * control just set. Repeated calls in one tick collapse into one save.
   */
  requestSave: () => void;
  /**
   * Attach to the element wrapping the page's fields: leaving a text input,
   * textarea or editor commits it.
   */
  onBlurCapture: React.FocusEventHandler;
}

const isTextEntry = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches('input, textarea, [contenteditable="true"]');
};

export const useAutosave = (save: () => Promise<AutosaveResult>): Autosave => {
  const { t } = useI18n();
  const [requestCount, setRequestCount] = React.useState(0);

  // The routine closes over the page's current form state, so it is read at
  // save time rather than captured when the request was queued.
  const saveRef = React.useRef(save);
  saveRef.current = save;
  // A save that is still in flight when the next one is queued must not be the
  // one that decides the reported outcome.
  const generationRef = React.useRef(0);

  const requestSave = React.useCallback(() => {
    setRequestCount((count) => count + 1);
  }, []);

  const onBlurCapture = React.useCallback<React.FocusEventHandler>((event) => {
    if (!isTextEntry(event.target)) return;
    requestSave();
  }, [requestSave]);

  React.useEffect(() => {
    if (requestCount === 0) return;
    let cancelled = false;
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    void (async () => {
      let result: AutosaveResult;
      try {
        result = await saveRef.current();
      } catch (error) {
        result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      if (cancelled || generationRef.current !== generation) return;
      if (!result.ok) {
        toast.error(t('settings.common.status.saveFailedReason', { reason: result.reason }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [requestCount]);

  return { requestSave, onBlurCapture };
};
