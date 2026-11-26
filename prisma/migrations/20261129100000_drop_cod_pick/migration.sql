-- Whether the store offers cash on delivery is no longer asked of the
-- merchant. Every order goes through the store's checkout page, which shows
-- the ways of paying the store offers by itself.
ALTER TABLE "ShopSettings" DROP COLUMN "codAvailable";
