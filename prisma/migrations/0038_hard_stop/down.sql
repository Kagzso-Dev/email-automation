-- Rollback for 0038_hard_stop (not run by Prisma; apply by hand). Set ENABLE_HARD_STOP=false and restart the API and
-- worker FIRST, so nothing writes CANCELLED or reads the hard-stop tables while this runs.
--
-- 1. Rows a hard stop cancelled become SKIPPED (their reason "Hard stop by <user> at <time>" stays in `error`), so
--    the CANCELLED value can be removed. Nothing else in those tables changes.
-- 2. Removing an ENUM value rebuilds the table (a copy, unlike the instant add in migration.sql); on a big table run
--    this at a quiet time.
-- 3. The two hard-stop tables are dropped: the stop records and the cancelled-rows CSVs are lost.
--
-- Then remove 0038 from Prisma's history, or the next `prisma migrate deploy` skips it:
--   DELETE FROM `_prisma_migrations` WHERE `migration_name` = '0038_hard_stop';
UPDATE `ManualSendBatchItem` SET `status` = 'SKIPPED' WHERE `status` = 'CANCELLED';
UPDATE `whatsapp_sends` SET `status` = 'SKIPPED' WHERE `status` = 'CANCELLED';

ALTER TABLE `ManualSendBatchItem` MODIFY `status` ENUM('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING';
ALTER TABLE `whatsapp_sends` MODIFY `status` ENUM('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'QUEUED';

DROP TABLE IF EXISTS `hard_stop_items`;
DROP TABLE IF EXISTS `hard_stops`;
