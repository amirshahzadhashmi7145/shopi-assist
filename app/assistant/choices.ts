/**
 * Turns a question the assistant asked with its answers written out as a
 * list into the same question with the answers as buttons.
 *
 * The assistant has a tool for offering buttons, but models often write the
 * options into the reply instead. A shopper should get buttons either way,
 * so the reply is read here, after the model is done: a short list of short
 * answers that follows a question is lifted out of the text and handed to the
 * widget as choices. Lists that are not answers (products with prices, steps,
 * policy points) are left where they are.
 *
 * Nothing here touches Shopify, the database or an LLM.
 */

const LIST_ITEM = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+?)\s*$/;
const MAX_CHOICES = 8;
const MAX_CHOICE_LENGTH = 50;

/** "**Too big**." -> "Too big". */
function plain(item: string): string {
  return item
    .replace(/\*\*|__|`/g, "")
    .replace(/[\s.;,?!]+$/, "")
    .trim();
}

/** Short enough, and plainly a thing to pick rather than a product, a price or a link. */
function isAnswer(item: string): boolean {
  if (!item || item.length > MAX_CHOICE_LENGTH) return false;
  if (item.split(/\s+/).length > 6) return false;
  if (/[$€£¥₹]|\d[.,]\d{2}\b|https?:|\]\(|:\s/.test(item)) return false;
  return true;
}

interface Block {
  /** Index of the block's first and last line. */
  start: number;
  end: number;
  items: string[];
}

/** The lists in a reply, each as the lines it spans. Blank lines may sit between items. */
function listBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = LIST_ITEM.exec(lines[index]);
    if (match) {
      if (!current) {
        current = { start: index, end: index, items: [] };
        blocks.push(current);
      }
      current.items.push(plain(match[1]));
      current.end = index;
    } else if (lines[index].trim() !== "") {
      current = null;
    }
  }
  return blocks;
}

const isChoiceBlock = (block: Block) =>
  block.items.length >= 2 &&
  block.items.length <= MAX_CHOICES &&
  block.items.every(isAnswer);

export interface LiftedChoices {
  /** The reply without the list. */
  text: string;
  choices: string[];
}

/** True when the text is asking the shopper to pick or to say something. */
const isAsking = (text: string) =>
  /\?|\b(choose|select|pick|which|options?)\b/i.test(text);

/**
 * Answers written into a sentence instead of a list: "Here are some options:
 * Changed my mind, Wrong item, or Too big." The sentence that lists them is
 * taken out, and so is a closing remark after it.
 */
function liftInlineChoices(reply: string): LiftedChoices | null {
  const sentences = reply.trim().split(/(?<=[.?!])\s+/);
  for (let index = 0; index < sentences.length; index += 1) {
    const colon = sentences[index].indexOf(":");
    if (colon < 0) continue;
    const items = sentences[index]
      .slice(colon + 1)
      .split(",")
      .map((item) => plain(item.replace(/^\s*(?:or|and)\s+/i, "")))
      .filter(Boolean);
    if (items.length < 3 || items.length > MAX_CHOICES) continue;
    if (!items.every((item) => isAnswer(item) && item.split(/\s+/).length <= 4))
      continue;

    const before = sentences.slice(0, index).join(" ").trim();
    // The list's own sentence may be the question: "Which fits best: A, B, or C?"
    const opener = sentences[index].slice(0, colon).trim();
    const question = before || `${opener}?`.replace(/\?+$/, "?");
    if (!isAsking(before || opener)) continue;

    const after = sentences
      .slice(index + 1)
      .join(" ")
      .trim();
    const keepAfter = after && (after.length > 80 || after.includes("?"));
    const choices = [
      ...new Map(items.map((item) => [item.toLowerCase(), item])).values(),
    ];
    if (choices.length < 3) continue;
    return { text: keepAfter ? `${question}\n\n${after}` : question, choices };
  }
  return null;
}

/**
 * The reply's first list of answers, lifted out. Null when the reply has no
 * such list, or the list does not follow a question.
 */
export function liftChoices(reply: string): LiftedChoices | null {
  return liftListChoices(reply) ?? liftInlineChoices(reply);
}

function liftListChoices(reply: string): LiftedChoices | null {
  const lines = reply.split("\n");
  const blocks = listBlocks(lines);
  const first = blocks.findIndex(isChoiceBlock);
  if (first < 0) return null;
  const block = blocks[first];

  // What leads up to the list has to be asking something.
  const before = lines.slice(0, block.start).join("\n").trim();
  const leadIn = before.split(/\n\s*\n/).pop() ?? "";
  if (!isAsking(leadIn)) return null;

  // "Which order? Here are your recent orders to choose from:" keeps the
  // question and loses the announcement of a list that is no longer there.
  const sentences = before.split(/(?<=[.?!])\s+/);
  const last = sentences[sentences.length - 1] ?? "";
  const question =
    last.trim().endsWith(":") &&
    sentences.slice(0, -1).some((sentence) => sentence.includes("?"))
      ? sentences.slice(0, -1).join(" ").trim()
      : before;
  if (!question) return null;

  // One question at a time: a second list of answers further down is the
  // next question, which the assistant asks again once this one is answered.
  // Otherwise what follows stays, unless it is only a closing pleasantry.
  const after = lines
    .slice(block.end + 1)
    .join("\n")
    .trim();
  const moreChoices = blocks.slice(first + 1).some(isChoiceBlock);
  const keepAfter =
    !moreChoices && after && (after.length > 80 || after.includes("?"));

  const choices = [
    ...new Map(block.items.map((item) => [item.toLowerCase(), item])).values(),
  ];
  if (choices.length < 2) return null;
  return { text: keepAfter ? `${question}\n\n${after}` : question, choices };
}

/** The last sentence of a reply, when it is a question. */
function closingQuestion(reply: string): string | null {
  const sentences = reply.trim().split(/(?<=[.?!])\s+/);
  const last = (sentences[sentences.length - 1] ?? "").trim();
  return last.endsWith("?") ? last : null;
}

/**
 * True when the reply ends by asking something a plain yes or no answers:
 * "Would you like to cancel it instead?". Not when it offers alternatives
 * ("...this one or that one?") or asks for something to be typed.
 */
export function asksYesOrNo(reply: string): boolean {
  const question = closingQuestion(reply);
  if (!question || question.length > 160) return false;
  if (
    /\bor\b|\bwhich\b|\bwhat\b|\bhow\b|\bwhen\b|\bwhere\b|\bwho\b/i.test(
      question,
    )
  )
    return false;
  return /^(would you like|do you want|shall i|should i|want me to|is that (right|correct|ok|okay)|are you sure|can i go ahead|may i)\b/i.test(
    question,
  );
}

/** True when the reply asks the shopper which of their orders they mean. */
export function asksWhichOrder(reply: string): boolean {
  // "Let me know which order..." asks it too, without a question mark.
  if (/\bwhich order\b/i.test(reply)) return true;
  return reply.includes("?") && /\bwhich one\b|\border number\b/i.test(reply);
}

/** True when the reply asks why the shopper wants to return something. */
export function asksReturnReason(reply: string): boolean {
  return (
    reply.includes("?") && /\breason\b/i.test(reply) && /\breturn/i.test(reply)
  );
}
