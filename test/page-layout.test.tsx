/**
 * Every page of the app uses the whole width of the admin, and puts what
 * goes beside its content in a column of its own.
 *
 * Shopify's page draws its own side column (`slot="aside"`) only at its
 * default width, the one with empty space left and right of the content. On
 * a full-width page whatever is given that slot is simply not drawn, with no
 * error, so a section left there would vanish from the page.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PAGE_WIDTH, PageColumns } from "../app/components/PageColumns";

const ROUTES = join(process.cwd(), "app", "routes");
const pages = readdirSync(ROUTES)
  .filter((file) => /^app\..+\.tsx$/.test(file))
  .map((file) => ({ file, source: readFileSync(join(ROUTES, file), "utf8") }))
  .filter((page) => page.source.includes("<s-page"));

describe("the app's pages", () => {
  it("are all as wide as the admin lets them be", () => {
    expect(PAGE_WIDTH).toBe("large");
    // Home, the setup tour, Settings, Conversations and the store assistant.
    expect(pages.map((page) => page.file).sort()).toEqual([
      "app._index.tsx",
      "app.assistant.tsx",
      "app.conversations.tsx",
      "app.settings.tsx",
      "app.setup.tsx",
    ]);
    for (const { file, source } of pages) {
      const opened = source.match(/<s-page\b[^>]*>/g) ?? [];
      expect(opened.length, file).toBeGreaterThan(0);
      for (const tag of opened) expect(tag, file).toContain("inlineSize={PAGE_WIDTH}");
    }
  });

  it("leave nothing in the slot a full-width page does not draw", () => {
    for (const { file, source } of pages) {
      expect(source, file).not.toMatch(/slot=["']aside["']/);
    }
  });
});

describe("a page's two columns", () => {
  const markup = renderToStaticMarkup(
    <PageColumns aside={<p>beside</p>}>
      <p>content</p>
    </PageColumns>,
  );

  it("put the content first and what goes with it in a side column", () => {
    expect(markup.indexOf("content")).toBeLessThan(markup.indexOf("beside"));
    // Announced as a side column, as Shopify's own is.
    expect(markup).toMatch(/<s-stack[^>]*accessibilityRole="aside"[^>]*><p>beside<\/p>/);
  });

  it("go side by side only where there is room, and one under the other elsewhere", () => {
    const columns = markup.match(/gridTemplateColumns="([^"]+)"/)?.[1] ?? "";
    expect(columns).toBe("@container (inline-size &gt; 1000px) 1fr 380px, 1fr");
    // Shopify splits the value at its commas: the one comma is the one
    // between the two layouts, so neither layout may hold another.
    expect(columns.split(",")).toHaveLength(2);
    // The widths are read against the page's own width, not the screen's.
    expect(markup.startsWith("<s-query-container>")).toBe(true);
  });
});
