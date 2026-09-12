-- AlterTable: WhatsApp templates are text-only (Twilio Content SID + body +
-- positional variables + quick-reply button labels). `headerMediaType` and
-- `headerMediaUrl` were applied directly to the database outside of a tracked
-- migration and were never part of the WhatsApp template schema, API, or UI —
-- no application code reads or writes them. Dropping them here brings the
-- database back in line with prisma/schema.prisma's WhatsAppTemplate model.
-- whatsapp_templates is isolated from the email Template table (see schema.prisma
-- comment above WhatsAppTemplate); this does not touch any email column.
ALTER TABLE `whatsapp_templates`
    DROP COLUMN `headerMediaType`,
    DROP COLUMN `headerMediaUrl`;
