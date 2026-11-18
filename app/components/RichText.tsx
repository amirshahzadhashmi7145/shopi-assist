import { Fragment } from "react";

import { parseRichText, type Inline } from "../assistant/rich-text";

function InlineParts({ parts }: { parts: Inline[] }) {
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

/** Renders assistant output (a small, safe Markdown subset) with Polaris elements. */
export function RichText({ text }: { text: string }) {
  const blocks = parseRichText(text);

  return (
    <s-stack direction="block" gap="small">
      {blocks.map((block, blockIndex) => {
        if (block.type === "list") {
          const items = block.items.map((item, itemIndex) => (
            <s-list-item key={itemIndex}>
              <InlineParts parts={item} />
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
                <InlineParts parts={line} />
              </Fragment>
            ))}
          </s-paragraph>
        );
      })}
    </s-stack>
  );
}
