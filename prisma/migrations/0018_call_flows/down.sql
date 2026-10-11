-- Rollback for 0018_call_flows (not run by Prisma; apply by hand, then run
--   npx prisma migrate resolve --rolled-back 0018_call_flows
-- ). Drops only the three Call Flow tables; no existing table is touched.
DROP TABLE IF EXISTS `ai_call_run_flows`;
DROP TABLE IF EXISTS `call_flow_versions`;
DROP TABLE IF EXISTS `call_flows`;
