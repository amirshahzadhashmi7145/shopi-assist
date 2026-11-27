-- The chat no longer takes pay-on-delivery orders: every order is placed on
-- the store's checkout page, whichever way the shopper pays. The switch for
-- it goes, with the name and note its order form showed for paying on
-- delivery. (What the address form asks for stays: a change of delivery
-- address still uses it.)
ALTER TABLE "ShopSettings" DROP COLUMN "allowChatOrders";
ALTER TABLE "ShopSettings" DROP COLUMN "orderPaymentName";
ALTER TABLE "ShopSettings" DROP COLUMN "orderPaymentNote";
