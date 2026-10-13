-- CreateTable
CREATE TABLE `branding_settings` (
    `key` VARCHAR(64) NOT NULL,
    `value` VARCHAR(64) NOT NULL,
    `updatedBy` VARCHAR(191) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
