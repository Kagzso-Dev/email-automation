# Import filter step and Upload History (`ENABLE_IMPORT_FILTER_STEP`)

Before **Import file** imports anything on **WhatsApp Contacts** or **Voicecall Contact** (English, Tamil and
every other language page), the file's rows open in the Data Quality filter view. Only **Import N selected**
sends the chosen rows to that page's existing importer, and only then is the upload written to **Upload
History**. Email Contacts and Send Queue are not affected.

## Switch it on / off

| `.env` (API) | Behaviour |
|---|---|
| `ENABLE_IMPORT_FILTER_STEP=true` | Filter step on both pages, "Exclude already used data", Upload History page |
| unset, blank, `false` (default) | **Import file works exactly as before**; `/api/import-filter` and `/api/upload-history` answer 404; the Upload History menu item is hidden |

Restart the API after changing it (PM2: restart the API process). No web rebuild is needed: the web app asks
`GET /api/import-filter/config`.

**Database:** Upload History needs migration **0037_upload_history** (one new table, `upload_history`; no
existing table is altered, no foreign key). Run `npm run prisma:deploy`. Until it is applied, the history
endpoints answer **503** with that instruction, the step shows "Imported, but this upload couldn't be added to
Upload History", and **imports still work**.

## Rollback

1. Set `ENABLE_IMPORT_FILTER_STEP=false` (or remove it) and restart the API. Imports work exactly as before;
   nothing reads or writes `upload_history`.
2. Optional, to remove the data: run `prisma/migrations/0037_upload_history/down.sql` by hand (drops the
   table), then `DELETE FROM _prisma_migrations WHERE migration_name = '0037_upload_history';`.
3. Optional, to remove the code: delete the new files below and revert the hook-in lines.

## What happens

1. **WhatsApp Contacts:** picking a file opens the filter step. The file is read with the WhatsApp
   importer's own column names and phone rule (first 1,000 rows, as the importer).
   **Voicecall Contact:** Choose file → column mapping (as today) → **Next: filter N valid rows**.
2. Each row is checked with the Data Quality rules (check status, rules score, tier, phone type). The **AI
   score is not used** (it needs a saved Data Quality job).
3. **Exclude already used data**: all three options are **ticked** by default. Ticked = matching rows are shown
   with the reason (e.g. "Already sent 12 Nov 2026 (WhatsApp)"), cannot be selected and are **not imported**.
   Unticked = they go to the importer like any other row (its own duplicate rules apply).

   | Option | WhatsApp Contacts | Voicecall Contact |
   |---|---|---|
   | Already in contacts (this channel) | already a WhatsApp contact | already in **this page's language list** (the importer's own rule) |
   | Already sent to | WhatsApp sends; email logs and Send Queue email batches when the file has an email column | WhatsApp sends; email logs and Send Queue email batches |
   | Already called | call logs; do not call / not interested / wrong person | same |

   "Sent" and "called" reuse the Send Queue "Filter new data" logic (`historyFilter.ts`): sent / done / still
   sending count, a failed-only send or failed call does not (so it can be retried).
   On WhatsApp, numbers already saved are therefore excluded by default; untick "Already in contacts" to
   import them, and the import then updates those contacts. **Clear filters** does not change these options.
4. Default filters: WhatsApp = Phone type **Mobile** only; Voicecall = **Mobile + Landline**. Language (from the
   script of the name and business) = all ticked. The counter reads "Showing X of Y, Z excluded as already used".
5. **Download excluded rows** saves the excluded rows (original columns + "Excluded because") as CSV, in the
   browser; nothing is uploaded.
6. **Import N selected** (live count, disabled at 0, never above 1,000) sends the rows that are shown, ticked,
   not rejected, not excluded, and that the importer takes, to the unchanged importer
   (`POST /api/whatsapp/contacts/import` as `<file>-selected.csv`, or `POST /api/ai-call-customers/import…`).
7. The summary shows imported, failed, duplicates, **Excluded (already used)** and **Filtered out**. Each row
   read is counted once: excluded → failed (the importer can't take it) → filtered out → sent.
8. **Back** returns to file selection. Nothing is imported and no history is written. A failed import writes no
   history either.

## Upload History

Menu **System → Upload History** (admins and editors; everyone sees every upload). Newest first, 25 per page,
search by file name. Click a row for the counts, the filters and exclusion options used, and **Download
excluded rows**. The excluded rows are kept **30 days**, then deleted (on any history request and by an hourly
sweep in the API process); the record with its counts and filters stays.

Endpoints: `GET /api/upload-history`, `GET /api/upload-history/:id`, `GET /api/upload-history/:id/excluded`
(410 after 30 days), `POST /api/upload-history` (written by the step after the importer answered; the user and
time come from the session and the server, never from the request).

## Files

New: `apps/api/src/config/importFilterStep.ts`, `apps/api/src/domain/importFilterCheck.ts`,
`apps/api/src/domain/importFilterUsed.ts`, `apps/api/src/domain/uploadHistory.ts`,
`apps/api/src/http/routes/importFilter.ts`, `apps/api/src/http/routes/uploadHistory.ts`,
`prisma/migrations/0037_upload_history/{migration.sql,down.sql}`, `apps/web/src/lib/importFilter.ts`,
`apps/web/src/lib/uploadHistory.ts`, `apps/web/src/components/ImportFilterStep.tsx`,
`apps/web/src/components/ImportFilterFlows.tsx`, `apps/web/src/pages/UploadHistory.tsx`; tests
`apps/api/test/{importFilterCheck,importFilterHttp,importFilterUsed,uploadHistoryHttp}.test.ts`,
`apps/api/test/fakePrismaPlus.ts`, `apps/web/test/{importFilterStep,importFilterExclusions,uploadHistoryPage}.test.tsx`.

Hook-ins: `prisma/schema.prisma` (the `UploadHistory` model only), `apps/api/src/http/app.ts` (2 route lines),
`.env.example`, `apps/web/src/App.tsx` (1 route), `apps/web/src/components/Layout.tsx` (menu item, only with
the flag on), `apps/web/src/pages/DataQuality.tsx` (`FilterPanel`, `CheckGroup` exported),
`apps/web/src/pages/WhatsAppContacts.tsx`, `apps/web/src/components/AiCallCustomersPanel.tsx`.

## Manual test checklist

Use a throwaway database with migration 0037 applied. Prepare a CSV with: 2 new mobiles, 1 Indian landline
(044…), 1 number already in WhatsApp Contacts, 1 number already in the English Voicecall list, 1 number sent a
WhatsApp message, 1 number with only a FAILED WhatsApp send, 1 number called, 1 do-not-call number, 1 repeated
number, 1 Tamil name, an email column with one address already emailed, and 1,005 rows for the limit test.

**Flag OFF (regression)**
- [ ] WhatsApp Contacts → Import file → imports at once; summary card as before.
- [ ] Voicecall (English, then Tamil `/ta/…`) → Choose file → "Import N valid rows" → imports as before.
- [ ] No "Upload History" in the menu; `/upload-history` says "Not available".
- [ ] Send Queue: "Filter new data" and "Download all history" unchanged. Data Quality page unchanged.

**Flag ON, before migration 0037**
- [ ] Import through the step works; the summary warns that history couldn't be saved; Upload History shows the
      503 message.

**Flag ON: WhatsApp Contacts**
- [ ] Filter step: Phone type Mobile only; all languages and all three "already used" options ticked; the note
      about saved numbers is shown.
- [ ] Saved / sent / called / do-not-call rows show their reason with a date and have no checkbox; the failed-only
      send is NOT excluded; the counter says "Z excluded as already used".
- [ ] Untick each option in turn: its rows become selectable and "Import N selected" grows.
- [ ] Download excluded rows: the CSV holds exactly the excluded rows with "Excluded because".
- [ ] 1,005-row file: the over-limit note shows; "Import N selected" never exceeds 1,000.
- [ ] Back → file picker; nothing imported; no new Upload History row.
- [ ] Import → summary with Excluded (already used) and Filtered out → "Saved to Upload History".

**Flag ON: Voicecall Contact (English, then Tamil)**
- [ ] Mobile + Landline ticked; the number in the English list is excluded on the English page only.
- [ ] Repeated number shows "skipped, as today"; do-not-call excluded by default, imported as "Do not call"
      when "Already called" is unticked.
- [ ] Back → "Choose file"; nothing imported; no history.
- [ ] Admin with "Also import into other languages" → per-language table; one history row.

**Upload History**
- [ ] Newest first; search by part of a file name; Prev / Next.
- [ ] Detail: counts match the import summary; filters and exclusion options listed; download works.
- [ ] Set a row's `excludedExpiresAt` in the past → download disabled, "deleted after 30 days"; counts kept.
- [ ] Editor account sees the page and every upload.
