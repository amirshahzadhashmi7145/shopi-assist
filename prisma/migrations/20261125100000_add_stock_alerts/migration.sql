-- CreateTable
CREATE TABLE "StockAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL DEFAULT '',
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "notifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "StockAlert_shop_email_productId_variantId_key" ON "StockAlert"("shop", "email", "productId", "variantId");

-- CreateIndex
CREATE INDEX "StockAlert_shop_productId_notifiedAt_idx" ON "StockAlert"("shop", "productId", "notifiedAt");

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "stockAlerts" BOOLEAN NOT NULL DEFAULT false;
