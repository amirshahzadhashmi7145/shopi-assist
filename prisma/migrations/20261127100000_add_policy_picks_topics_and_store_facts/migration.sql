-- More of the store's policies as picks, answers picked for common questions,
-- and what Shopify itself says about the store.
ALTER TABLE "ShopSettings" ADD COLUMN "aboutStore" TEXT NOT NULL DEFAULT 'shopify';
ALTER TABLE "ShopSettings" ADD COLUMN "topics" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "ShopSettings" ADD COLUMN "storeFacts" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "ShopSettings" ADD COLUMN "returnConditions" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopSettings" ADD COLUMN "exchanges" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopSettings" ADD COLUMN "refundMethod" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopSettings" ADD COLUMN "shippingFee" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopSettings" ADD COLUMN "shippingAmount" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopSettings" ADD COLUMN "codAvailable" TEXT NOT NULL DEFAULT '';

-- A store that already wrote its own description keeps using it.
UPDATE "ShopSettings" SET "aboutStore" = 'custom' WHERE "businessDescription" <> '';
