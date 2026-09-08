-- AlterTable: templates gain repeatable image / video lists. The pre-existing
-- single `imageUrl` / `videoUrl` columns stay for older templates; the renderer
-- merges them ahead of these arrays. Both nullable — templates without them
-- render exactly as before.
ALTER TABLE `Template`
    ADD COLUMN `images` JSON NULL,
    ADD COLUMN `videos` JSON NULL;
