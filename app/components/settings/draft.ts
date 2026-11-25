/**
 * What the merchant has picked in Settings so far, before saving.
 *
 * The settings controls are left to themselves (uncontrolled): this only
 * listens to what they report and keeps a copy. The copy decides what else
 * is shown (a feature's own options only once it is on, a text box only once
 * "Custom" is picked), fills in the fields that are worked out from several
 * controls, and feeds the live preview.
 *
 * Plain data in, plain data out: nothing here touches the page.
 */
import {
  CUSTOM_PREFIX,
  GREETING_PRESETS,
  PAYMENT_NAME_PRESETS,
  PAYMENT_NOTE_PRESETS,
  RETURN_CONDITIONS,
  TOPICS,
  readTopicAnswer,
  type TopicAnswers,
} from "../../assistant/setting-options";
import type { AssistantSettings } from "../../assistant/settings.server";

/** Text boxes that stay away until the merchant asks for them. */
export type OpenKey = "returnPolicy" | "shippingInfo" | "faq" | "instructions";

export interface DraftUi {
  /** Which welcome message: a preset's position as text, or "custom". */
  greetingMode: string;
  greetingText: string;
  /** "" for Shopify's own name, a preset's position, or "custom". */
  paymentNameMode: string;
  paymentNameText: string;
  /** "" for no note, a preset's position, or "custom". */
  paymentNoteMode: string;
  paymentNoteText: string;
  /** Per topic: "" for not set, a listed answer's value, or "custom". */
  topicPick: Record<string, string>;
  topicText: Record<string, string>;
  open: Record<OpenKey, boolean>;
}

export interface DraftState {
  /** Each setting as its own control last reported it. */
  values: AssistantSettings;
  ui: DraftUi;
}

/** What a control reported: read off the element by the page, see useSettingsDraft. */
export interface ControlInput {
  name: string;
  /** The element's tag, lower case: "s-switch", "s-select"... */
  tag: string;
  checked: boolean;
  value: string;
  values: string[];
}

const CUSTOM = "custom";

/** A stored text as a pick: one of the presets, the merchant's own, or (where allowed) none. */
function toMode(stored: string, presets: readonly string[]): { mode: string; text: string } {
  if (!stored) return { mode: "", text: "" };
  const index = presets.indexOf(stored);
  return index >= 0 ? { mode: String(index), text: "" } : { mode: CUSTOM, text: stored };
}

function fromMode(mode: string, text: string, presets: readonly string[]): string {
  if (mode === CUSTOM) return text.trim();
  if (mode === "") return "";
  return presets[Number(mode)] ?? "";
}

export function initialDraft(settings: AssistantSettings): DraftState {
  const greeting = toMode(settings.greeting, GREETING_PRESETS);
  const paymentName = toMode(settings.orderPaymentName, PAYMENT_NAME_PRESETS);
  const paymentNote = toMode(settings.orderPaymentNote, PAYMENT_NOTE_PRESETS);

  const topicPick: Record<string, string> = {};
  const topicText: Record<string, string> = {};
  for (const topic of TOPICS) {
    const answer = readTopicAnswer(settings.topics[topic.key]);
    topicPick[topic.key] = answer.pick;
    topicText[topic.key] = answer.text;
  }

  return {
    values: { ...settings },
    ui: {
      // A store always has a welcome message, so there is no "none" here.
      greetingMode: greeting.mode || "0",
      greetingText: greeting.text,
      paymentNameMode: paymentName.mode,
      paymentNameText: paymentName.text,
      paymentNoteMode: paymentNote.mode,
      paymentNoteText: paymentNote.text,
      topicPick,
      topicText,
      // Shown from the start only where the merchant already wrote something.
      open: {
        returnPolicy: settings.returnPolicy.length > 0,
        shippingInfo: settings.shippingInfo.length > 0,
        faq: settings.faq.length > 0,
        instructions: settings.instructions.length > 0,
      },
    },
  };
}

const UI_TEXT = ["greetingText", "paymentNameText", "paymentNoteText"] as const;
const UI_MODE = ["greetingMode", "paymentNameMode", "paymentNoteMode"] as const;

/** The state after one control reported a change. Unknown controls change nothing. */
export function applyInput(state: DraftState, control: ControlInput): DraftState {
  const { name } = control;
  // A list of choices reports what is picked as a list, even when only one can be.
  const single = control.tag === "s-choice-list" ? (control.values[0] ?? "") : control.value;

  if (name.startsWith("ui.")) {
    const [, key, topic] = name.split(".");
    if ((UI_TEXT as readonly string[]).includes(key) || (UI_MODE as readonly string[]).includes(key)) {
      return { ...state, ui: { ...state.ui, [key]: single } };
    }
    if (key === "topic" && topic) {
      return { ...state, ui: { ...state.ui, topicPick: { ...state.ui.topicPick, [topic]: single } } };
    }
    if (key === "topicText" && topic) {
      return { ...state, ui: { ...state.ui, topicText: { ...state.ui.topicText, [topic]: single } } };
    }
    return state;
  }

  if (!(name in state.values)) return state;
  const field = name as keyof AssistantSettings;
  const current = state.values[field];
  const ticks = control.tag === "s-checkbox" || control.tag === "s-switch";
  const next =
    typeof current === "boolean"
      ? control.checked
      : typeof current === "number"
        ? Number(single) || current
        : Array.isArray(current)
          ? ticks
            ? // One tick box per value, all under the same name.
              [
                ...current.filter((entry) => entry !== control.value),
                ...(control.checked ? [control.value] : []),
              ]
            : control.values
          : typeof current === "string"
            ? single
            : current;
  return { ...state, values: { ...state.values, [field]: next } };
}

export function openBox(state: DraftState, key: OpenKey): DraftState {
  return { ...state, ui: { ...state.ui, open: { ...state.ui.open, [key]: true } } };
}

function topicAnswers(ui: DraftUi): TopicAnswers {
  const answers: TopicAnswers = {};
  for (const topic of TOPICS) {
    const pick = ui.topicPick[topic.key] ?? "";
    if (pick === CUSTOM) {
      const text = (ui.topicText[topic.key] ?? "").trim();
      if (text) answers[topic.key] = CUSTOM_PREFIX + text;
    } else if (pick) {
      answers[topic.key] = pick;
    }
  }
  return answers;
}

/**
 * The settings as they would be saved now. The fields worked out from
 * several controls (a welcome message that is a preset or the merchant's own
 * words, the answers to common questions) are filled in here.
 */
export function resolveDraft(state: DraftState): AssistantSettings {
  const { values, ui } = state;
  return {
    ...values,
    // In the list's own order, however the boxes were ticked: ticking one off
    // and on again is not a change.
    returnConditions: RETURN_CONDITIONS.filter((condition) =>
      values.returnConditions.includes(condition),
    ),
    greeting: fromMode(ui.greetingMode, ui.greetingText, GREETING_PRESETS),
    orderPaymentName: fromMode(ui.paymentNameMode, ui.paymentNameText, PAYMENT_NAME_PRESETS),
    orderPaymentNote: fromMode(ui.paymentNoteMode, ui.paymentNoteText, PAYMENT_NOTE_PRESETS),
    topics: topicAnswers(ui),
  };
}

export function sameDraft(a: AssistantSettings, b: AssistantSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
