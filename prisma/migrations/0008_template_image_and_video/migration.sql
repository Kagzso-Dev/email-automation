-- AlterTable: templates gain optional image and video links used to enrich the
-- email body. Both nullable — templates without them render exactly as before.
ALTER TABLE `Template`
    ADD COLUMN `imageUrl` VARCHAR(2000) NULL,
    ADD COLUMN `videoUrl` VARCHAR(2000) NULL;
