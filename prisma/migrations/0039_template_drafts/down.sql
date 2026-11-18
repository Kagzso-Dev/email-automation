-- Rollback for 0039_template_drafts (not run by Prisma; apply by hand). Set ENABLE_TEMPLATE_DRAFTS=false and restart
-- the API FIRST: with the flag off nothing reads or writes this table, and both templates pages work as before.
--
-- Drops every saved draft (they are lost). No other table is touched; templates are never affected.
--
-- Then remove 0039 from Prisma's history, or the next `prisma migrate deploy` skips it:
--   DELETE FROM `_prisma_migrations` WHERE `migration_name` = '0039_template_drafts';
DROP TABLE IF EXISTS `template_drafts`;
