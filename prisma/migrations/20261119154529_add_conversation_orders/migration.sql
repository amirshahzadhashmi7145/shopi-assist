-- CreateTable
CREATE TABLE "ConversationOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConversationOrder_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ConversationOrder_shop_idx" ON "ConversationOrder"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationOrder_conversationId_orderId_key" ON "ConversationOrder"("conversationId", "orderId");
