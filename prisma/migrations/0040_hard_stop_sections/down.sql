-- Rollback for 0040_hard_stop_sections (not run by Prisma; apply by hand). Restart the API and worker on code without
-- the section buttons FIRST.
--
-- The records of section stops (EMAIL, WHATSAPP, CALLS) are deleted, with their hard_stop_items rows (cascade), so the
-- values can be removed. The rows those stops cancelled keep their CANCELLED status and reason in their own tables.
--
-- Then remove 0040 from Prisma's history, or the next `prisma migrate deploy` skips it:
--   DELETE FROM `_prisma_migrations` WHERE `migration_name` = '0040_hard_stop_sections';
DELETE FROM `hard_stops` WHERE `scope` IN ('EMAIL', 'WHATSAPP', 'CALLS');

ALTER TABLE `hard_stops` MODIFY `scope` ENUM('ALL', 'EMAIL_BATCH', 'WHATSAPP_BATCH', 'AI_CALL_RUN', 'CAMPAIGN') NOT NULL;
