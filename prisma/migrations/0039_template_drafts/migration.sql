-- Template drafts (ENABLE_TEMPLATE_DRAFTS): an unfinished "New template" form on Templates (email) or WhatsApp
-- Templates -> Create in Meta, saved so it can be resumed. A draft is never a template: nothing that sends, lists
-- templates or talks to Meta reads this table. Drafts not edited for 30 days are deleted by the API.
-- One NEW table only: no existing table is altered or dropped, and there is no foreign key (owner and last editor
-- are snapshots, so deleting a user is unaffected). Undo: down.sql.

-- CreateTable
CREATE TABLE `template_drafts` (
    `id` VARCHAR(64) NOT NULL,
    `channel` VARCHAR(16) NOT NULL,
    `name` VARCHAR(255) NULL,
    `state` JSON NOT NULL,
    `ownerId` VARCHAR(191) NOT NULL,
    `ownerEmail` VARCHAR(191) NOT NULL,
    `lastEditedById` VARCHAR(191) NOT NULL,
    `lastEditedByEmail` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `template_drafts_channel_updatedAt_idx`(`channel`, `updatedAt`),
    INDEX `template_drafts_updatedAt_idx`(`updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
