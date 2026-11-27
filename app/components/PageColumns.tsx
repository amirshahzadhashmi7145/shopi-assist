/**
 * The two columns of an admin page: the page's own content, and a narrower
 * column beside it for what goes with that content (a preview, a short list).
 *
 * Shopify's page can lay out a side column itself (`slot="aside"`), but only
 * at its default width: a fixed column in the middle of the screen, with
 * empty space left and right of it. These pages use the whole width instead
 * (`inlineSize={PAGE_WIDTH}` on `s-page`), where that slot is not drawn, so
 * they place the side column themselves. Where there is no room for both,
 * the side column goes under the main one, as Shopify's own does.
 */
import type { ReactNode } from "react";

/** Every page of the app is as wide as the admin lets it be. */
export const PAGE_WIDTH = "large";

export function PageColumns({ children, aside }: { children: ReactNode; aside: ReactNode }) {
  return (
    <s-query-container>
      {/* Shopify splits a responsive value at its commas, so neither set of
          columns may hold one: `1fr`, not `minmax(0, 1fr)`. */}
      <s-grid
        gridTemplateColumns="@container (inline-size > 1000px) 1fr 380px, 1fr"
        gap="base"
        alignItems="start"
      >
        <s-stack direction="block" gap="base">
          {children}
        </s-stack>
        <s-stack direction="block" gap="base" accessibilityRole="aside">
          {aside}
        </s-stack>
      </s-grid>
    </s-query-container>
  );
}
