-- CreateTable
CREATE TABLE `ai_call_test_numbers` (
    `id` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `label` VARCHAR(60) NULL,
    `createdBy` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `ai_call_test_numbers_phone_key`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
