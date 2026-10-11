-- Rollback for 0021_whatsapp_inbox_reads (not run by Prisma; apply by hand, then run
--   npx prisma migrate resolve --rolled-back 0021_whatsapp_inbox_reads
-- ). Drops only the Inbox read-state table; messages are untouched.
DROP TABLE IF EXISTS `whatsapp_conversation_reads`;
