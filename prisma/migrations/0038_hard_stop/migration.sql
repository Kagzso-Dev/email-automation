-- Hard stop (ENABLE_HARD_STOP, off by default): "Hard stop" on one send, or "Stop all running sends" (admin). Work
-- already in progress always finishes; everything not started is cancelled with "Hard stop by <user> at <time>".
-- Undo: down.sql.
--
-- 1. Two existing status lists get one more value at the END: CANCELLED, for an email of a Send Queue email batch
--    (ManualSendBatchItem) and a WhatsApp message (whatsapp_sends) that the stop cancelled before it was sent.
--    Nothing is removed or renamed and no existing row changes; with the flag off nothing writes the new value.
--    Appending an ENUM value is a metadata-only change in MySQL 8 (no table copy, reads and writes continue).
--    ALGORITHM=INPLACE, LOCK=NONE makes MySQL refuse with an error instead of copying the table if it ever couldn't
--    do it that way, and lock_wait_timeout makes the ALTER give up after 15 s (instead of queueing every query on
--    that table behind it) if a long transaction holds the table. A refused or timed-out ALTER changes nothing:
--    run the deploy again.
-- 2. Two new tables: hard_stops (one row per press, the audit record) and hard_stop_items (what each stop touched,
--    with the contact snapshot for the cancelled-rows CSV). No other table is touched.

SET SESSION lock_wait_timeout = 15;

-- AlterTable
ALTER TABLE `ManualSendBatchItem` MODIFY `status` ENUM('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED') NOT NULL DEFAULT 'PENDING', ALGORITHM=INPLACE, LOCK=NONE;

-- AlterTable
ALTER TABLE `whatsapp_sends` MODIFY `status` ENUM('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED', ALGORITHM=INPLACE, LOCK=NONE;

-- CreateTable
CREATE TABLE `hard_stops` (
    `id` VARCHAR(191) NOT NULL,
    `scope` ENUM('ALL', 'EMAIL_BATCH', 'WHATSAPP_BATCH', 'AI_CALL_RUN', 'CAMPAIGN') NOT NULL,
    `targetId` VARCHAR(191) NULL,
    `activeKey` VARCHAR(191) NULL,
    `status` ENUM('STOPPING', 'STOPPED') NOT NULL DEFAULT 'STOPPING',
    `reason` VARCHAR(255) NOT NULL,
    `byUserId` VARCHAR(191) NOT NULL,
    `byEmail` VARCHAR(191) NOT NULL,
    `appliedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `inProgressAtStop` INTEGER NOT NULL DEFAULT 0,
    `cancelledItems` INTEGER NOT NULL DEFAULT 0,
    `cancelledFollowups` INTEGER NOT NULL DEFAULT 0,
    `completedItems` INTEGER NULL,
    `detail` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    UNIQUE INDEX `hard_stops_activeKey_key`(`activeKey`),
    INDEX `hard_stops_status_idx`(`status`),
    INDEX `hard_stops_scope_targetId_idx`(`scope`, `targetId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `hard_stop_items` (
    `id` VARCHAR(191) NOT NULL,
    `stopId` VARCHAR(191) NOT NULL,
    `channel` VARCHAR(16) NOT NULL,
    `kind` VARCHAR(24) NOT NULL,
    `refTable` VARCHAR(32) NOT NULL,
    `refId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(32) NULL,
    `businessName` VARCHAR(191) NULL,
    `extra` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `hard_stop_items_stopId_kind_idx`(`stopId`, `kind`),
    UNIQUE INDEX `hard_stop_items_stopId_kind_refTable_refId_key`(`stopId`, `kind`, `refTable`, `refId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `hard_stop_items` ADD CONSTRAINT `hard_stop_items_stopId_fkey` FOREIGN KEY (`stopId`) REFERENCES `hard_stops`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
