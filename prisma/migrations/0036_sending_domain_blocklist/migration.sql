-- Settings → Domain mode (ENABLE_DOMAIN_BLOCKLIST): "Email all domains except blocked ones". Two new tables:
-- the Blocked list (used only in BLOCKLIST mode) and an append-only log of who changed the domain rules. The
-- mode itself is a row in the existing `Setting` table (key "sendingDomainMode"); no row = ALLOWLIST, so
-- existing installs keep the Approved list until an admin switches. Additive only: AllowedDomain and every
-- other table are untouched. Undo: down.sql.

-- CreateTable
CREATE TABLE `blocked_sending_domains` (
    `id` VARCHAR(191) NOT NULL,
    `domain` VARCHAR(191) NOT NULL,
    `createdBy` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `blocked_sending_domains_domain_key`(`domain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sending_domain_audit` (
    `id` VARCHAR(191) NOT NULL,
    `action` VARCHAR(32) NOT NULL,
    `detail` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `userEmail` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sending_domain_audit_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
