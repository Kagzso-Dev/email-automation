-- Rollback for 0019_ai_call_customers (not run by Prisma; apply by hand, then run
--   npx prisma migrate resolve --rolled-back 0019_ai_call_customers
-- ). Drops only the four AI Call Customer tables; no existing table is touched.
DROP TABLE IF EXISTS `ai_call_followups`;
DROP TABLE IF EXISTS `ai_call_customer_events`;
DROP TABLE IF EXISTS `ai_call_customer_calls`;
DROP TABLE IF EXISTS `ai_call_customers`;
