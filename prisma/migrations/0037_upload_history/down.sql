-- Rollback for 0037_upload_history (not run by Prisma; apply by hand). Set ENABLE_IMPORT_FILTER_STEP=false and
-- restart the API FIRST: with the flag off nothing reads or writes this table, and imports work as before.
--
-- Drops the upload history (all records and any excluded-rows files still kept are lost). No other table is touched.
--
-- Then remove 0037 from Prisma's history, or the next `prisma migrate deploy` skips it:
--   DELETE FROM `_prisma_migrations` WHERE `migration_name` = '0037_upload_history';
DROP TABLE IF EXISTS `upload_history`;
