-- CreateTable
CREATE TABLE `ai_call_runs` (
    `id` VARCHAR(191) NOT NULL,
    `mode` ENUM('RANDOM', 'SELECTED', 'ALL') NOT NULL,
    `status` ENUM('RUNNING', 'DONE', 'CANCELLED') NOT NULL DEFAULT 'RUNNING',
    `gapSeconds` INTEGER NOT NULL,
    `maxCalls` INTEGER NOT NULL,
    `total` INTEGER NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdByEmail` VARCHAR(191) NULL,
    `skipped` JSON NULL,
    `nextCallAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ai_call_runs_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_call_logs` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL,
    `customerName` VARCHAR(191) NULL,
    `gender` VARCHAR(16) NULL,
    `followUpDetail` TEXT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `status` ENUM('QUEUED', 'DIALING', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `voiceCallId` VARCHAR(64) NULL,
    `providerCallId` VARCHAR(64) NULL,
    `outcome` VARCHAR(32) NULL,
    `error` TEXT NULL,
    `durationSec` INTEGER NULL,
    `transcript` LONGTEXT NULL,
    `summary` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `endedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ai_call_logs_runId_position_idx`(`runId`, `position`),
    INDEX `ai_call_logs_voiceCallId_idx`(`voiceCallId`),
    INDEX `ai_call_logs_phone_idx`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ai_call_logs` ADD CONSTRAINT `ai_call_logs_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `ai_call_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

