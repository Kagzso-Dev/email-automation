-- Rollback for 0024_branding_settings (not run by Prisma; apply by hand, then run
--   npx prisma migrate resolve --rolled-back 0024_branding_settings
-- ). Drops only the branding table; no existing table is touched.
-- The app shows the default names ("Dispatch", "Dashboard", …) without it.
DROP TABLE IF EXISTS `branding_settings`;
