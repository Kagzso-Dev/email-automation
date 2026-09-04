-- CreateTable
CREATE TABLE `whatsapp_contacts` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `firstName` VARCHAR(191) NULL,
    `lastName` VARCHAR(191) NULL,
    `businessName` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'UNSUBSCRIBED', 'BLOCKED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `whatsapp_contacts_phone_key`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `whatsapp_templates` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `contentSid` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `variables` JSON NOT NULL,
    `buttonLabels` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `whatsapp_send_batches` (
    `id` VARCHAR(191) NOT NULL,
    `templateId` VARCHAR(191) NOT NULL,
    `minDelaySec` INTEGER NOT NULL,
    `maxDelaySec` INTEGER NOT NULL,
    `status` ENUM('RUNNING', 'DONE', 'CANCELLED') NOT NULL DEFAULT 'RUNNING',
    `total` INTEGER NOT NULL,
    `nextItemAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `whatsapp_send_batches_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `whatsapp_sends` (
    `id` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NULL,
    `whatsappContactId` VARCHAR(191) NULL,
    `templateId` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `businessName` VARCHAR(191) NULL,
    `body` TEXT NOT NULL,
    `contentVariables` JSON NULL,
    `status` ENUM('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'QUEUED',
    `providerMessageId` VARCHAR(191) NULL,
    `error` TEXT NULL,
    `sentAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `whatsapp_sends_batchId_status_idx`(`batchId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `whatsapp_send_batches` ADD CONSTRAINT `whatsapp_send_batches_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `whatsapp_templates`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `whatsapp_sends` ADD CONSTRAINT `whatsapp_sends_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `whatsapp_send_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `whatsapp_sends` ADD CONSTRAINT `whatsapp_sends_whatsappContactId_fkey` FOREIGN KEY (`whatsappContactId`) REFERENCES `whatsapp_contacts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
