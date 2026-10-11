-- CreateTable
CREATE TABLE `whatsapp_conversation_reads` (
    `phone` VARCHAR(32) NOT NULL,
    `lastReadAt` DATETIME(3) NOT NULL,
    `readByEmail` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`phone`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

