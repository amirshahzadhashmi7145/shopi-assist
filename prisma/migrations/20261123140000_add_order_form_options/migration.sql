-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "orderFirstName" TEXT NOT NULL DEFAULT 'optional';
ALTER TABLE "ShopSettings" ADD COLUMN "orderCompany" TEXT NOT NULL DEFAULT 'hidden';
ALTER TABLE "ShopSettings" ADD COLUMN "orderAddress2" TEXT NOT NULL DEFAULT 'optional';
