-- CreateTable
CREATE TABLE `whatsapp_media` (
    `id` VARCHAR(191) NOT NULL,
    `purpose` ENUM('INBOUND', 'TEMPLATE_HEADER', 'REPLY') NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `status` ENUM('PENDING', 'STORED', 'FAILED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `mimeType` VARCHAR(128) NULL,
    `filename` VARCHAR(255) NULL,
    `sizeBytes` INTEGER NULL,
    `sha256` VARCHAR(64) NULL,
    `storageKey` VARCHAR(128) NULL,
    `providerMediaId` VARCHAR(128) NULL,
    `providerMediaAt` DATETIME(3) NULL,
    `inboundMessageId` VARCHAR(191) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `error` TEXT NULL,
    `createdByEmail` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `whatsapp_media_inboundMessageId_key`(`inboundMessageId`),
    INDEX `whatsapp_media_purpose_status_idx`(`purpose`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `whatsapp_template_header_media` (
    `templateId` VARCHAR(191) NOT NULL,
    `mediaId` VARCHAR(191) NOT NULL,
    `updatedByEmail` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `whatsapp_template_header_media_mediaId_idx`(`mediaId`),
    PRIMARY KEY (`templateId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `whatsapp_send_media` (
    `sendId` VARCHAR(191) NOT NULL,
    `mediaId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `whatsapp_send_media_mediaId_idx`(`mediaId`),
    PRIMARY KEY (`sendId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `whatsapp_template_header_media` ADD CONSTRAINT `whatsapp_template_header_media_mediaId_fkey` FOREIGN KEY (`mediaId`) REFERENCES `whatsapp_media`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `whatsapp_send_media` ADD CONSTRAINT `whatsapp_send_media_mediaId_fkey` FOREIGN KEY (`mediaId`) REFERENCES `whatsapp_media`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

