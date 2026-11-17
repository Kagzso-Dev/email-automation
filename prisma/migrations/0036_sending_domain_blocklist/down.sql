-- Rollback for 0036_sending_domain_blocklist (not run by Prisma; apply by hand). Set ENABLE_DOMAIN_BLOCKLIST=false
-- and restart the API and worker FIRST: with the flag off nothing reads these tables, and the app is back on the
-- Approved list (AllowedDomain is never changed by this feature).
--
-- Drops the Blocked list and the change log (both are lost), and removes the stored mode. No other table is touched.
--
-- Then remove 0036 from Prisma's history, or the next `prisma migrate deploy` skips it:
--   DELETE FROM `_prisma_migrations` WHERE `migration_name` = '0036_sending_domain_blocklist';
DROP TABLE IF EXISTS `blocked_sending_domains`;
DROP TABLE IF EXISTS `sending_domain_audit`;
DELETE FROM `Setting` WHERE `key` = 'sendingDomainMode';
