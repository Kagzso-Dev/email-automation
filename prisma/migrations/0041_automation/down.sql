-- Rollback for 0041_automation (not run by Prisma; apply by hand). Set ENABLE_AUTOMATION=false and restart the API
-- FIRST: with the flag off nothing reads or writes these tables, the sidebar has no Automation section, and every
-- /api/automation endpoint answers 404.
--
-- Drops the DM send log and the campaign action log (they are lost). No other table is touched. Campaigns on LinkedIn
-- / Meta and messages already sent on Instagram are NOT affected — they live on those platforms.
--
-- Then remove 0041 from Prisma's history, or the next `prisma migrate deploy` skips it:
--   DELETE FROM `_prisma_migrations` WHERE `migration_name` = '0041_automation';
DROP TABLE IF EXISTS `automation_campaign_actions`;
DROP TABLE IF EXISTS `automation_dm_sends`;
