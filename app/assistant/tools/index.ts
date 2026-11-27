import { merchantTools } from "./merchant";
import { orderChangeTools } from "./order-changes";
import type { ToolDefinition } from "./registry";
import { shopperTools as catalogAndOrderTools } from "./shopper";
import { storeInfoTools } from "./store-info";

/** Everything a shopper's chat may be offered, before settings narrow it down. */
const shopperTools: ToolDefinition[] = [
  ...catalogAndOrderTools,
  ...storeInfoTools,
  ...orderChangeTools,
];

/**
 * Every tool the assistant knows. Which of these a given chat may use is
 * decided per request by `toolsFor`, based on the audience and shop settings.
 */
export const allTools: ToolDefinition[] = [...shopperTools, ...merchantTools];

export { merchantTools, shopperTools };
