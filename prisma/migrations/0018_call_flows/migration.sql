-- CreateTable
CREATE TABLE `call_flows` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `description` TEXT NULL,
    `base` VARCHAR(16) NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdByEmail` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `call_flow_versions` (
    `id` VARCHAR(191) NOT NULL,
    `flowId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'PUBLISHED') NOT NULL DEFAULT 'DRAFT',
    `definition` JSON NOT NULL,
    `definitionHash` VARCHAR(64) NOT NULL,
    `createdByEmail` VARCHAR(191) NULL,
    `publishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `call_flow_versions_flowId_version_key`(`flowId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_call_run_flows` (
    `runId` VARCHAR(191) NOT NULL,
    `flowVersionId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_call_run_flows_flowVersionId_idx`(`flowVersionId`),
    PRIMARY KEY (`runId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `call_flow_versions` ADD CONSTRAINT `call_flow_versions_flowId_fkey` FOREIGN KEY (`flowId`) REFERENCES `call_flows`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_call_run_flows` ADD CONSTRAINT `ai_call_run_flows_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `ai_call_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_call_run_flows` ADD CONSTRAINT `ai_call_run_flows_flowVersionId_fkey` FOREIGN KEY (`flowVersionId`) REFERENCES `call_flow_versions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

