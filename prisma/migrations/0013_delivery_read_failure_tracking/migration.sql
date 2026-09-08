-- AlterTable: record when a send-time failure or a later bounce/complaint
-- webhook set EmailLog to FAILED/BOUNCED/COMPLAINED, alongside errorMessage.
ALTER TABLE `EmailLog` ADD COLUMN `failedAt` DATETIME(3) NULL;

-- AlterTable: WhatsApp read-receipt ("Opened") status + timestamp, and a
-- failure timestamp alongside the existing `error` column.
ALTER TABLE `whatsapp_sends` MODIFY COLUMN `status` ENUM('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'QUEUED';
ALTER TABLE `whatsapp_sends` ADD COLUMN `readAt` DATETIME(3) NULL;
ALTER TABLE `whatsapp_sends` ADD COLUMN `failedAt` DATETIME(3) NULL;
