/**
 * "How the chat is doing" on the app's home page: a few numbers, three rings
 * and a bar for each of the last seven days, drawn from the shop's own chats.
 * Plain SVG and markup: no chart library.
 */
import type { ChatAnalytics } from "../assistant/store.server";

/** One number with what it counts under it. */
function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {note ? <s-text color="subdued">{note}</s-text> : null}
      </s-stack>
    </s-box>
  );
}

// Chart colours. Blue and orange are told apart by people with any common
// colour blindness (checked); the three blues run light to dark for "more".
// The grey is for the part of a whole that is simply the rest.
const CHART = {
  blue: "#2a78d6",
  orange: "#eb6834",
  blueLight: "#86b6ef",
  blueDark: "#104281",
  rest: "#d9d9d9",
  ink: "#303030",
  soft: "#616161",
} as const;

interface Slice {
  label: string;
  value: number;
  color: string;
}

/**
 * One whole split into a few parts, as a ring with the headline figure in
 * the middle. The legend under it names every part with its number, so the
 * chart never rests on colour alone and reads the same when printed.
 */
function Ring({
  title,
  slices,
  figure,
  caption,
  empty,
  footnote,
}: {
  title: string;
  slices: Slice[];
  figure: string;
  caption: string;
  empty: string;
  /** Something the ring leaves out, said in words under the legend. */
  footnote?: string;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const shown = slices.filter((slice) => slice.value > 0);
  // A circle of circumference 100, so a part's share is its length.
  const RADIUS = 15.9155;
  // A sliver of the card between neighbours keeps them apart without an outline.
  const gap = shown.length > 1 ? 1.2 : 0;
  const arcs = shown.map((slice, index) => {
    const share = (slice.value / total) * 100;
    // Each part starts where the ones before it end, from twelve o'clock.
    const before = shown
      .slice(0, index)
      .reduce((sum, earlier) => sum + (earlier.value / total) * 100, 0);
    return { ...slice, share, offset: 25 - before, length: Math.max(0.6, share - gap) };
  });

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{title}</s-text>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: "12px" }}>
          <svg
            viewBox="0 0 42 42"
            width="120"
            height="120"
            role="img"
            aria-label={
              total > 0
                ? `${title}: ${slices.map((slice) => `${slice.label} ${slice.value}`).join(", ")}`
                : `${title}: ${empty}`
            }
            style={{ alignSelf: "center" }}
          >
            <circle cx="21" cy="21" r={RADIUS} fill="none" stroke={CHART.rest} strokeWidth="5" opacity={total > 0 ? 0 : 1} />
            {arcs.map((arc) => (
              <circle
                key={arc.label}
                cx="21"
                cy="21"
                r={RADIUS}
                fill="none"
                stroke={arc.color}
                strokeWidth="5"
                strokeDasharray={`${arc.length} ${100 - arc.length}`}
                strokeDashoffset={arc.offset}
              >
                <title>{`${arc.label}: ${arc.value} (${Math.round(arc.share)}%)`}</title>
              </circle>
            ))}
            <text
              x="21"
              y={total > 0 ? "21" : "22.6"}
              textAnchor="middle"
              fontSize={total > 0 ? "7.4" : "4.4"}
              fontWeight="600"
              fill={total > 0 ? CHART.ink : CHART.soft}
            >
              {total > 0 ? figure : "No data"}
            </text>
            {total > 0 ? (
              <text x="21" y="26.4" textAnchor="middle" fontSize="3.3" fill={CHART.soft}>
                {caption}
              </text>
            ) : null}
          </svg>
          <div style={{ display: "grid", gap: "5px", fontSize: "13px", color: CHART.ink }}>
            {total > 0 ? (
              slices.map((slice) => (
                <div key={slice.label} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span
                    aria-hidden="true"
                    style={{
                      flex: "0 0 auto",
                      width: "10px",
                      height: "10px",
                      borderRadius: "3px",
                      background: slice.color,
                    }}
                  />
                  <span style={{ flex: "1 1 auto", whiteSpace: "nowrap" }}>{slice.label}</span>
                  <span
                    style={{ fontVariantNumeric: "tabular-nums", color: CHART.soft, whiteSpace: "nowrap" }}
                  >
                    {slice.value} · {Math.round((slice.value / total) * 100)}%
                  </span>
                </div>
              ))
            ) : (
              <span style={{ color: CHART.soft, textAlign: "center" }}>{empty}</span>
            )}
            {total > 0 && footnote ? <span style={{ color: CHART.soft }}>{footnote}</span> : null}
          </div>
        </div>
      </s-stack>
    </s-box>
  );
}

/** How the storefront chat has been used lately, from the chats on record. */
export function ChatAnalyticsSection({
  analytics,
  retentionDays,
  chatOrders,
}: {
  analytics: ChatAnalytics;
  retentionDays: number;
  chatOrders: boolean;
}) {
  const { conversations, shopperMessages, signedIn, ratings, ordersPlaced, lengths, perDay } =
    analytics;
  const rated = ratings.up + ratings.down;
  const notRated = Math.max(0, conversations.last30 - rated);
  const guests = Math.max(0, conversations.last30 - signedIn);
  const busiest = Math.max(1, ...perDay.map((day) => day.count));
  const share = (part: number, whole: number) =>
    whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
  const weekday = (date: string) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });

  return (
    <s-section heading="How the chat is doing">
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
          <Stat
            label="Conversations, last 7 days"
            value={String(conversations.last7)}
            note={`${conversations.last30} in the last 30 days`}
          />
          <Stat
            label="Shopper messages, 30 days"
            value={String(shopperMessages)}
            note={
              conversations.last30 > 0
                ? `${(shopperMessages / conversations.last30).toFixed(1)} per conversation`
                : undefined
            }
          />
          {chatOrders || ordersPlaced > 0 ? (
            <Stat
              label="Orders placed in chat, 30 days"
              value={String(ordersPlaced)}
              note="Pay on delivery"
            />
          ) : null}
        </s-grid>

        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(210px, 1fr))" gap="base">
          <Ring
            title="Ratings, last 30 days"
            figure={share(ratings.up, rated)}
            caption="thumbs up"
            empty="No chat has been rated yet."
            footnote={
              notRated > 0
                ? `${notRated} of ${conversations.last30} ${conversations.last30 === 1 ? "chat" : "chats"} not rated`
                : undefined
            }
            slices={[
              { label: "Thumbs up", value: ratings.up, color: CHART.blue },
              { label: "Thumbs down", value: ratings.down, color: CHART.orange },
            ]}
          />
          <Ring
            title="Shoppers, last 30 days"
            figure={share(signedIn, conversations.last30)}
            caption="signed in"
            empty="No conversations yet."
            slices={[
              { label: "Signed in", value: signedIn, color: CHART.blue },
              { label: "Guest", value: guests, color: CHART.rest },
            ]}
          />
          <Ring
            title="Messages per chat, last 30 days"
            figure={String(lengths.one + lengths.few + lengths.many)}
            caption="chats"
            empty="No conversations yet."
            slices={[
              { label: "1 message", value: lengths.one, color: CHART.blueLight },
              { label: "2 to 4", value: lengths.few, color: CHART.blue },
              { label: "5 or more", value: lengths.many, color: CHART.blueDark },
            ]}
          />
        </s-grid>

        <s-stack direction="block" gap="small-200">
          <s-text color="subdued">Conversations started each day</s-text>
          <div
            role="img"
            aria-label={`Conversations started each day: ${perDay
              .map((day) => `${weekday(day.date)} ${day.count}`)
              .join(", ")}`}
            style={{ display: "flex", alignItems: "flex-end", gap: "8px", height: "96px" }}
          >
            {perDay.map((day) => (
              <div
                key={day.date}
                title={`${day.date}: ${day.count}`}
                style={{
                  flex: "1 1 0",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  gap: "4px",
                  height: "100%",
                  fontSize: "12px",
                  color: "#616161",
                }}
              >
                <span>{day.count}</span>
                <div
                  style={{
                    width: "100%",
                    maxWidth: "48px",
                    height: `${Math.max(2, Math.round((day.count / busiest) * 52))}px`,
                    borderRadius: "4px 4px 0 0",
                    background: day.count > 0 ? CHART.blue : CHART.rest,
                  }}
                />
                <span>{weekday(day.date)}</span>
              </div>
            ))}
          </div>
        </s-stack>

        <s-stack direction="inline" gap="base" alignItems="center">
          <s-link href="/app/conversations">View conversations</s-link>
          <s-text color="subdued">
            Counted from the chats on record, which are kept for {retentionDays}{" "}
            {retentionDays === 1 ? "day" : "days"}. Days are in UTC.
          </s-text>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
