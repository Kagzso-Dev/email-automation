-- AlterTable: record when a delivery webhook confirmed the message arrived.
ALTER TABLE `EmailLog` ADD COLUMN `deliveredAt` DATETIME(3) NULL;

-- AlterTable: link a drip-batch item to the EmailLog it produced, so the Send
-- Queue detail can show that recipient's delivered / opened times.
ALTER TABLE `ManualSendBatchItem` ADD COLUMN `emailLogId` VARCHAR(191) NULL;
