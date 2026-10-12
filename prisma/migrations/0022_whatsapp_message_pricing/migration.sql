-- CreateTable
CREATE TABLE `whatsapp_message_pricing` (
    `providerMessageId` VARCHAR(191) NOT NULL,
    `billable` BOOLEAN NULL,
    `category` VARCHAR(64) NULL,
    `pricingModel` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`providerMessageId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

