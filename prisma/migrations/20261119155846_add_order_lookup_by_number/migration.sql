-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "instructions" TEXT NOT NULL DEFAULT '',
    "orderLookupEnabled" BOOLEAN NOT NULL DEFAULT false,
    "orderLookupByNumber" BOOLEAN NOT NULL DEFAULT false,
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "businessDescription" TEXT NOT NULL DEFAULT '',
    "returnPolicy" TEXT NOT NULL DEFAULT '',
    "shippingInfo" TEXT NOT NULL DEFAULT '',
    "faq" TEXT NOT NULL DEFAULT '',
    "assistantName" TEXT NOT NULL DEFAULT '',
    "greeting" TEXT NOT NULL DEFAULT '',
    "tone" TEXT NOT NULL DEFAULT 'friendly',
    "allowAddToCart" BOOLEAN NOT NULL DEFAULT true,
    "allowCheckout" BOOLEAN NOT NULL DEFAULT true,
    "allowReturns" BOOLEAN NOT NULL DEFAULT false,
    "allowChatOrders" BOOLEAN NOT NULL DEFAULT false,
    "returnWindow" TEXT NOT NULL DEFAULT '',
    "returnShipping" TEXT NOT NULL DEFAULT '',
    "processingTime" TEXT NOT NULL DEFAULT '',
    "deliveryTime" TEXT NOT NULL DEFAULT '',
    "shipsTo" TEXT NOT NULL DEFAULT '',
    "setupStartedAt" DATETIME,
    "setupCompletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShopSettings" ("allowAddToCart", "allowChatOrders", "allowCheckout", "allowReturns", "assistantName", "businessDescription", "createdAt", "deliveryTime", "enabled", "faq", "greeting", "instructions", "orderLookupEnabled", "processingTime", "retentionDays", "returnPolicy", "returnShipping", "returnWindow", "setupCompletedAt", "setupStartedAt", "shippingInfo", "shipsTo", "shop", "tone", "updatedAt") SELECT "allowAddToCart", "allowChatOrders", "allowCheckout", "allowReturns", "assistantName", "businessDescription", "createdAt", "deliveryTime", "enabled", "faq", "greeting", "instructions", "orderLookupEnabled", "processingTime", "retentionDays", "returnPolicy", "returnShipping", "returnWindow", "setupCompletedAt", "setupStartedAt", "shippingInfo", "shipsTo", "shop", "tone", "updatedAt" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
