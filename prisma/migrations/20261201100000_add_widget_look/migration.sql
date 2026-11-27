-- The chat widget's colour and the corner it sits in are set in the app's
-- Settings now, not in the theme editor. An empty colour is the app's
-- default. An empty corner is one not picked yet: it follows the store's
-- language until it is.
ALTER TABLE "ShopSettings" ADD COLUMN "accentColor" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopSettings" ADD COLUMN "widgetPosition" TEXT NOT NULL DEFAULT '';
