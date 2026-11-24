-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "rating" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "ratedAt" DATETIME;

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "chatRatings" BOOLEAN NOT NULL DEFAULT true;
