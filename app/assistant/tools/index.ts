import { merchantTools } from "./merchant";
import type { ToolDefinition } from "./registry";
import { shopperTools } from "./shopper";

/**
 * Every tool the assistant knows. Which of these a given chat may use is
 * decided per request by `toolsFor`, based on the audience and shop settings.
 */
export const allTools: ToolDefinition[] = [...shopperTools, ...merchantTools];

export { merchantTools, shopperTools };
