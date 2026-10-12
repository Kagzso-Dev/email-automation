-- Rollback for 0022_whatsapp_message_pricing (not run by Prisma; apply by hand, then run
--   npx prisma migrate resolve --rolled-back 0022_whatsapp_message_pricing
-- ). Drops only the pricing-info table; messages and statuses are untouched.
DROP TABLE IF EXISTS `whatsapp_message_pricing`;
