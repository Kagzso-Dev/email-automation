-- Upload History (ENABLE_IMPORT_FILTER_STEP): one row per confirmed "Import N selected" from the import filter
-- step on WhatsApp Contacts / Voicecall Contact, with the counts, the filters used and, for 30 days, the
-- excluded rows (as CSV text; cleared afterwards, the row itself stays). One NEW table only: no existing table is
-- altered or dropped, and there is no foreign key (who uploaded is a snapshot, so deleting a user is unaffected).
-- Undo: down.sql.

-- CreateTable
CREATE TABLE `upload_history` (
    `id` VARCHAR(191) NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `channel` VARCHAR(16) NOT NULL,
    `language` VARCHAR(8) NULL,
    `uploadedById` VARCHAR(191) NOT NULL,
    `uploadedByEmail` VARCHAR(191) NOT NULL,
    `totalRows` INTEGER NOT NULL,
    `imported` INTEGER NOT NULL,
    `excludedUsed` INTEGER NOT NULL,
    `filteredOut` INTEGER NOT NULL,
    `duplicates` INTEGER NOT NULL,
    `failed` INTEGER NOT NULL,
    `skippedOverLimit` INTEGER NOT NULL DEFAULT 0,
    `filters` JSON NOT NULL,
    `result` JSON NOT NULL,
    `excludedRows` INTEGER NOT NULL DEFAULT 0,
    `excludedCsv` MEDIUMTEXT NULL,
    `excludedExpiresAt` DATETIME(3) NOT NULL,
    `excludedPurgedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `upload_history_createdAt_idx`(`createdAt`),
    INDEX `upload_history_excludedExpiresAt_idx`(`excludedExpiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
