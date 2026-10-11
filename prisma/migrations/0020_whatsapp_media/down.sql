-- Rollback for 0020_whatsapp_media (not run by Prisma; apply by hand, then run
--   npx prisma migrate resolve --rolled-back 0020_whatsapp_media
-- ). Drops only the three WhatsApp media tables; no existing table is touched.
-- Stored files in WHATSAPP_MEDIA_DIR are left on disk (delete the folder by hand if wanted).
DROP TABLE IF EXISTS `whatsapp_send_media`;
DROP TABLE IF EXISTS `whatsapp_template_header_media`;
DROP TABLE IF EXISTS `whatsapp_media`;
