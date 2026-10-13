-- Rollback for 0023_ai_call_test_numbers (not run by Prisma; apply by hand, then run
--   npx prisma migrate resolve --rolled-back 0023_ai_call_test_numbers
-- ). Drops only the trial-number table; no existing table is touched.
-- AI_CALL_FLOW_TEST_NUMBERS keeps working without it.
DROP TABLE IF EXISTS `ai_call_test_numbers`;
