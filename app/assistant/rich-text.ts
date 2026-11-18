/**
 * Parser for the small Markdown subset the assistant is asked to use:
 * paragraphs, bullet and numbered lists, **bold** and [links](url).
 *
 * It produces plain data rather than HTML, so the UI can render it with
 * ordinary elements and model output can never inject markup.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "link"; text: string; href: string };

export type Block =
  | { type: "paragraph"; lines: Inline[][] }
  | { type: "list"; ordered: boolean; items: Inline[][] };

/** Allows http(s) links and same-site paths. Everything else is dropped. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\/[^\s]+$/i.test(href)) return href;
  if (/^\/(?!\/)[^\s]*$/.test(href)) return href;
  return null;
}

const INLINE_PATTERN =
  /\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"])/g;

export function parseInline(text: string): Inline[] {
  const parts: Inline[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ type: "text", text: text.slice(cursor, index) });

    if (match[1] !== undefined) {
      parts.push({ type: "bold", text: match[1] });
    } else if (match[2] !== undefined) {
      const href = safeHref(match[3]);
      parts.push(
        href ? { type: "link", text: match[2], href } : { type: "text", text: match[2] },
      );
    } else {
      const href = safeHref(match[4]);
      parts.push(
        href ? { type: "link", text: match[4], href } : { type: "text", text: match[4] },
      );
    }
    cursor = index + match[0].length;
  }

  if (cursor < text.length) parts.push({ type: "text", text: text.slice(cursor) });
  return parts;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;

export function parseRichText(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: Inline[][] = [];
  let list: { ordered: boolean; items: Inline[][] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", lines: paragraph });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: "list", ...list });
    list = null;
  };

  for (const rawLine of source.replace(/\r\n?/g, "\n").split("\n")) {
    // Headings are not part of the subset; show them as bold lines.
    const line = rawLine.replace(/^\s*#{1,6}\s+(.*)$/, "**$1**");
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);

    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      flushParagraph();
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(parseInline((bullet ?? numbered)![1]));
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(parseInline(line.trim()));
    }
  }

  flushParagraph();
  flushList();
  return blocks;
}
