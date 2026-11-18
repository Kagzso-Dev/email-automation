-- Hard stop per section (ENABLE_HARD_STOP): a "Hard stop" button on the Email, WhatsApp and each language's call pages
-- that stops only that section (Stop all stays in Send Queue). Three values are appended to the END of
-- hard_stops.scope (a table added by 0038 for this feature): EMAIL, WHATSAPP, CALLS (targetId = the language).
-- Nothing is removed or renamed and no row changes. Metadata-only in MySQL 8 (no table copy); see 0038 for the
-- ALGORITHM / lock_wait_timeout reasoning. Undo: down.sql.

SET SESSION lock_wait_timeout = 15;

-- AlterTable
ALTER TABLE `hard_stops` MODIFY `scope` ENUM('ALL', 'EMAIL_BATCH', 'WHATSAPP_BATCH', 'AI_CALL_RUN', 'CAMPAIGN', 'EMAIL', 'WHATSAPP', 'CALLS') NOT NULL, ALGORITHM=INPLACE, LOCK=NONE;
