-- AlterTable: templates gain a kind, an optional "call-to-action" link list, and
-- an optional structured meeting block (used when kind = 'MEETING').
ALTER TABLE `Template`
    ADD COLUMN `kind` ENUM('LETTER', 'MEETING') NOT NULL DEFAULT 'LETTER',
    ADD COLUMN `links` JSON NULL,
    ADD COLUMN `meeting` JSON NULL;
