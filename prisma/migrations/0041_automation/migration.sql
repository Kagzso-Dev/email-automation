-- Automation (ENABLE_AUTOMATION): LinkedIn Automation + Instagram Automation pages. automation_dm_sends logs every
-- DM recipient of every send (sent / failed / blocked — e.g. outside Instagram's 24-hour window);
-- automation_campaign_actions logs campaign create / pause / resume. Written only by /api/automation.
-- Two NEW tables only: no existing table is altered or dropped, and there is no foreign key (the user is a
-- snapshot, so deleting a user is unaffected). Undo: down.sql.

-- CreateTable
CREATE TABLE `automation_dm_sends` (
    `id` VARCHAR(191) NOT NULL,
    `platform` VARCHAR(16) NOT NULL,
    `batchId` VARCHAR(64) NOT NULL,
    `recipientId` VARCHAR(128) NOT NULL,
    `recipientName` VARCHAR(255) NULL,
    `message` TEXT NOT NULL,
    `messageTag` VARCHAR(32) NULL,
    `windowState` VARCHAR(16) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `providerMessageId` VARCHAR(191) NULL,
    `errorCode` VARCHAR(64) NULL,
    `errorMessage` VARCHAR(1000) NULL,
    `sentById` VARCHAR(191) NOT NULL,
    `sentByEmail` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `automation_dm_sends_platform_createdAt_idx`(`platform`, `createdAt`),
    INDEX `automation_dm_sends_batchId_idx`(`batchId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_campaign_actions` (
    `id` VARCHAR(191) NOT NULL,
    `platform` VARCHAR(16) NOT NULL,
    `campaignId` VARCHAR(64) NULL,
    `campaignName` VARCHAR(255) NULL,
    `action` VARCHAR(16) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `errorCode` VARCHAR(64) NULL,
    `errorMessage` VARCHAR(1000) NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `actorEmail` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `automation_campaign_actions_platform_createdAt_idx`(`platform`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

