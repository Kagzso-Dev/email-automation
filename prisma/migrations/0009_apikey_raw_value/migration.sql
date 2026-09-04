-- AlterTable: store the full raw API key so admins can reveal/copy it later.
-- Nullable — keys created before this migration have no stored raw value and
-- cannot be revealed (revoke and recreate to get a copyable key).
ALTER TABLE `ApiKey`
    ADD COLUMN `rawKey` TEXT NULL;
