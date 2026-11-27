-- Adding to the cart and checkout help are no longer switches. Every store
-- has them, so there is nothing to store.
ALTER TABLE "ShopSettings" DROP COLUMN "allowAddToCart";
ALTER TABLE "ShopSettings" DROP COLUMN "allowCheckout";
