import { ApiVersion } from "@shopify/shopify-app-react-router/server";
import { shopifyApiProject, ApiType } from "@shopify/api-codegen-preset";
import type { IGraphQLConfig } from "graphql-config";

// `npm run graphql-codegen` validates every `#graphql` document in the app
// against Shopify's published schemas and writes typed results to app/types.
//
// The storefront widget's catalog queries use the Storefront API; everything
// else uses the Admin API. Each set is checked against its own schema.
const STOREFRONT_DOCUMENTS = "./app/assistant/tools/storefront-queries.ts";

const config: IGraphQLConfig = {
  projects: {
    default: shopifyApiProject({
      apiType: ApiType.Admin,
      apiVersion: ApiVersion.October26,
      documents: ["./app/**/*.{js,ts,jsx,tsx}", `!${STOREFRONT_DOCUMENTS}`],
      outputDir: "./app/types",
    }),
    storefront: shopifyApiProject({
      apiType: ApiType.Storefront,
      apiVersion: ApiVersion.October26,
      documents: [STOREFRONT_DOCUMENTS],
      outputDir: "./app/types",
    }),
  },
};

export default config;
