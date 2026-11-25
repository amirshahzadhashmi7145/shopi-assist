import { useState } from "react";

import type { AssistantSettings } from "../../assistant/settings.server";
import {
  applyInput,
  initialDraft,
  openBox,
  resolveDraft,
  sameDraft,
  type ControlInput,
  type DraftState,
  type OpenKey,
} from "./draft";

/** What a settings control says about itself when it reports a change. */
function readControl(target: EventTarget | null): ControlInput | null {
  const element = target as
    | (Element & { checked?: unknown; value?: unknown; values?: unknown })
    | null;
  if (!element || typeof element.getAttribute !== "function") return null;
  const name = element.getAttribute("name");
  if (!name) return null;
  return {
    name,
    tag: element.tagName.toLowerCase(),
    checked: element.checked === true,
    value: typeof element.value === "string" ? element.value : "",
    values: Array.isArray(element.values) ? element.values.map(String) : [],
  };
}

export interface SettingsDraft {
  state: DraftState;
  /** The settings as they would be saved now. */
  draft: AssistantSettings;
  /** Something differs from what is saved. */
  dirty: boolean;
  /** For the form's `onInput`: every control inside reports through it. */
  handleInput: (event: { target: EventTarget | null }) => void;
  /** Shows a text box the merchant asked for. */
  open: (key: OpenKey) => void;
  /** For the form's `onReset`: back to the saved settings, as the controls go. */
  reset: () => void;
}

/**
 * Keeps a copy of what the merchant has picked since the page loaded.
 * Remount the component that calls this (a `key` that changes on save) to
 * start again from the saved settings.
 */
export function useSettingsDraft(settings: AssistantSettings): SettingsDraft {
  const [state, setState] = useState(() => initialDraft(settings));

  const handleInput = (event: { target: EventTarget | null }) => {
    const control = readControl(event.target);
    if (control) setState((current) => applyInput(current, control));
  };
  const open = (key: OpenKey) => setState((current) => openBox(current, key));
  const reset = () => setState(initialDraft(settings));

  const draft = resolveDraft(state);
  const dirty = !sameDraft(draft, resolveDraft(initialDraft(settings)));
  return { state, draft, dirty, handleInput, open, reset };
}
