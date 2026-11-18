import { Fragment } from "react";

import { parseRichText, type Inline } from "../assistant/rich-text";

type LinkMode = "active" | "plain";

function InlineParts({ parts, links }: { parts: Inline[]; links: LinkMode }) {
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "bold") {
          return (
            <s-text key={index} type="strong">
              {part.text}
            </s-text>
          );
        }
        if (part.type === "link" && links === "plain") {
          // Show where the link points instead of making it clickable.
          return (
            <Fragment key={index}>
              {part.text === part.href ? part.href : `${part.text} (${part.href})`}
            </Fragment>
          );
        }
        if (part.type === "link") {
          return (
            <s-link key={index} href={part.href} target="_blank">
              {part.text}
            </s-link>
          );
        }
        return <Fragment key={index}>{part.text}</Fragment>;
      })}
    </>
  );
}

/**
 * Renders assistant output (a small, safe Markdown subset) with Polaris elements.
 *
 * Use `links="plain"` for text an anonymous visitor could have steered, such
 * as stored shopper transcripts: a link label can hide its destination, so
 * there the destination is printed and nothing is clickable.
 */
export function RichText({ text, links = "active" }: { text: string; links?: LinkMode }) {
  const blocks = parseRichText(text);

  return (
    <s-stack direction="block" gap="small">
      {blocks.map((block, blockIndex) => {
        if (block.type === "list") {
          const items = block.items.map((item, itemIndex) => (
            <s-list-item key={itemIndex}>
              <InlineParts parts={item} links={links} />
            </s-list-item>
          ));
          return block.ordered ? (
            <s-ordered-list key={blockIndex}>{items}</s-ordered-list>
          ) : (
            <s-unordered-list key={blockIndex}>{items}</s-unordered-list>
          );
        }
        return (
          <s-paragraph key={blockIndex}>
            {block.lines.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 && <br />}
                <InlineParts parts={line} links={links} />
              </Fragment>
            ))}
          </s-paragraph>
        );
      })}
    </s-stack>
  );
}
