-- WhatsApp moves from Twilio to the Meta WhatsApp Cloud API. Additive only:
-- no WhatsApp row is deleted and no email table is touched.

-- AlterTable: Meta templates are addressed by name + language. The old
-- Content SID column stays (now nullable) so existing rows keep their value.
ALTER TABLE `whatsapp_templates` MODIFY COLUMN `contentSid` VARCHAR(191) NULL;
ALTER TABLE `whatsapp_templates` ADD COLUMN `providerTemplateName` VARCHAR(512) NULL;
ALTER TABLE `whatsapp_templates` ADD COLUMN `languageCode` VARCHAR(16) NOT NULL DEFAULT 'en';

-- AlterTable: record which provider sent each message. Rows that already
-- exist were sent through Twilio, so they are backfilled with that value;
-- new rows default to 'meta'.
ALTER TABLE `whatsapp_sends` ADD COLUMN `provider` VARCHAR(16) NOT NULL DEFAULT 'twilio';
ALTER TABLE `whatsapp_sends` ALTER COLUMN `provider` SET DEFAULT 'meta';
ALTER TABLE `whatsapp_sends` ADD COLUMN `errorCode` VARCHAR(32) NULL;

-- CreateIndex: status webhooks look sends up by provider message id.
CREATE INDEX `whatsapp_sends_providerMessageId_idx` ON `whatsapp_sends`(`providerMessageId`);

-- CreateTable: inbound messages from the Meta webhook.
CREATE TABLE `whatsapp_inbound_messages` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(16) NOT NULL DEFAULT 'meta',
    `providerMessageId` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(32) NOT NULL,
    `profileName` VARCHAR(191) NULL,
    `whatsappContactId` VARCHAR(191) NULL,
    `messageType` VARCHAR(32) NOT NULL,
    `body` TEXT NULL,
    `mediaId` VARCHAR(191) NULL,
    `mediaMimeType` VARCHAR(191) NULL,
    `replyPayload` TEXT NULL,
    `contextMessageId` VARCHAR(191) NULL,
    `sentAt` DATETIME(3) NOT NULL,
    `raw` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `whatsapp_inbound_messages_providerMessageId_key`(`providerMessageId`),
    INDEX `whatsapp_inbound_messages_phone_idx`(`phone`),
    INDEX `whatsapp_inbound_messages_contextMessageId_idx`(`contextMessageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `whatsapp_inbound_messages` ADD CONSTRAINT `whatsapp_inbound_messages_whatsappContactId_fkey` FOREIGN KEY (`whatsappContactId`) REFERENCES `whatsapp_contacts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
