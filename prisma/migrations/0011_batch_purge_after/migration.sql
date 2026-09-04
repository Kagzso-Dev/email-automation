-- AlterTable
ALTER TABLE `ManualSendBatch` ADD COLUMN `purgeAfter` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `ManualSendBatchItem` ADD COLUMN `name` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `whatsapp_send_batches` ADD COLUMN `purgeAfter` BOOLEAN NOT NULL DEFAULT false;
