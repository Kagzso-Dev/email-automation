-- CreateTable
CREATE TABLE `ai_call_customers` (
    `id` VARCHAR(191) NOT NULL,
    `customerName` VARCHAR(100) NULL,
    `gender` VARCHAR(16) NOT NULL DEFAULT 'unknown',
    `phone` VARCHAR(20) NOT NULL,
    `activePhone` VARCHAR(20) NULL,
    `businessName` VARCHAR(160) NULL,
    `followUpDetail` TEXT NULL,
    `email` VARCHAR(191) NULL,
    `whatsappOptIn` BOOLEAN NOT NULL DEFAULT false,
    `stage` ENUM('NOT_CALLED', 'QUEUED', 'CALLING', 'NO_ANSWER', 'FAILED', 'INTERESTED', 'NOT_INTERESTED', 'FOLLOW_UP_NEEDED', 'CALLBACK_REQUESTED', 'DO_NOT_CALL', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'NOT_CALLED',
    `needsReview` BOOLEAN NOT NULL DEFAULT false,
    `doNotCall` BOOLEAN NOT NULL DEFAULT false,
    `lastCallLogId` VARCHAR(191) NULL,
    `lastCalledAt` DATETIME(3) NULL,
    `createdByEmail` VARCHAR(191) NULL,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ai_call_customers_activePhone_key`(`activePhone`),
    INDEX `ai_call_customers_deletedAt_stage_idx`(`deletedAt`, `stage`),
    INDEX `ai_call_customers_phone_idx`(`phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_call_customer_calls` (
    `logId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_call_customer_calls_customerId_idx`(`customerId`),
    PRIMARY KEY (`logId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_call_customer_events` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(32) NOT NULL,
    `stage` ENUM('NOT_CALLED', 'QUEUED', 'CALLING', 'NO_ANSWER', 'FAILED', 'INTERESTED', 'NOT_INTERESTED', 'FOLLOW_UP_NEEDED', 'CALLBACK_REQUESTED', 'DO_NOT_CALL', 'APPROVED', 'REJECTED') NULL,
    `detail` TEXT NULL,
    `refId` VARCHAR(191) NULL,
    `actorEmail` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_call_customer_events_customerId_createdAt_idx`(`customerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_call_followups` (
    `id` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `channel` ENUM('WHATSAPP', 'CALL') NOT NULL,
    `status` ENUM('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'FAILED') NOT NULL DEFAULT 'PENDING_APPROVAL',
    `reason` VARCHAR(64) NULL,
    `whatsappTemplateId` VARCHAR(191) NULL,
    `scheduledAt` DATETIME(3) NULL,
    `attempt` INTEGER NOT NULL DEFAULT 1,
    `note` TEXT NULL,
    `sourceCallLogId` VARCHAR(191) NULL,
    `whatsappBatchId` VARCHAR(191) NULL,
    `aiCallRunId` VARCHAR(191) NULL,
    `error` TEXT NULL,
    `createdByEmail` VARCHAR(191) NULL,
    `decidedByEmail` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ai_call_followups_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `ai_call_followups_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ai_call_customer_calls` ADD CONSTRAINT `ai_call_customer_calls_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `ai_call_customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_call_customer_events` ADD CONSTRAINT `ai_call_customer_events_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `ai_call_customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_call_followups` ADD CONSTRAINT `ai_call_followups_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `ai_call_customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

