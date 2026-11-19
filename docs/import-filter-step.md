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
   **Voicecall Contact:** Choose file → the columns are matched automatically and the filter step opens
   straight away (the old column screen, its 300-row preview and its error list don't show). The column screen
   opens only when no Phone column was found, or on **Change columns** in the step's header; **Next: filter
   N valid rows** then returns to the step. Admins pick **Also import into other languages** in the step.
2. Each row is checked with the Data Quality rules (check status, rules score, tier, phone type), then gets
   **Data Quality's AI score**, exactly as on the Data Quality page and nothing saved: the valid rows go to
   `POST /api/import-filter/ai-score` 5 at a time with only their name, business name and rules score (never the
   phone number or the email); same service (DATA_QUALITY_AI_PROVIDER), prompt, overall score (rules + AI average)
   and tier; same pause between rows, wait while rate limited or while live AI calls run, stop when the service is
   down, the key is refused or 5 rows failed. The step shows "X of Y scored"; until scoring ends, **Score ≥,
   Approve, Reject, Only show rows scoring N+, Score from / to and Tier are disabled** (phone type, check status,
   text, dropdowns and the import stay usable). Not available = "<service> not available: … Only the standard
   checks run." Two differences, for the request behind nginx: a batch starts no new row after 15 s (the browser
   sends the rest), and one row waits at most 45 s.
   The score bar and the row table are the Data Quality page's own components (`components/DataQualityParts.tsx`;
   the Data Quality page renders exactly as before, held by `test/dataQualityPageSnapshot.test.tsx`). The import
   table adds Language and Already used; its row checkboxes reset when the filters, tab or "Only show" change, as
   on Data Quality (there every row is unpicked again, here every row is ticked again).
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
   **Clear filters** returns to these page defaults (not to a blank panel).
   The filter panel is the Data Quality page's own component: the four text searches, the **City / State /
   District / Pincode / Category / Source / Date added** dropdowns (shown when the file has those columns, found
   by Data Quality's header names, with counts), Email / Phone any, Score range, Check status, Phone type, Tier
   and Review. On WhatsApp the email column is read for these filters and the checks (the importer still
   doesn't store it). The Data Quality page itself is not changed.
5. **Download excluded rows** saves the excluded rows (original columns + "Excluded because") as CSV, in the
   browser; nothing is uploaded.
6. **Import N selected** (live count, disabled at 0, never above 1,000) sends the rows that are shown, ticked,
   not rejected, not excluded, and that the importer takes, to the unchanged importer
   (`POST /api/whatsapp/contacts/import` as `<file>-selected.csv`, or `POST /api/ai-call-customers/import…`).
7. The summary shows imported, failed, duplicates, **Excluded (already used)** and **Filtered out**. Each row
   read is counted once: excluded → failed (the importer can't take it) → filtered out → sent.
8. **Back** (in the header and next to Import) returns to file selection. Nothing is imported and no history is
   written. A failed import writes no history either.

## Upload History

Menu **System → Upload History** (admins and editors; everyone sees every upload). Newest first, 25 per page,
search by file name. Click a row for the counts, the filters and exclusion options used, and **Download
excluded rows**. Each upload is **deleted 30 days after it was made** (its row, counts, filters and excluded
rows), on any history request and by an hourly sweep in the API process (`scheduler.ts` is not involved).
A missing migration never blocks an import: the history write answers 503 and the step shows a warning.

Endpoints: `GET /api/upload-history`, `GET /api/upload-history/:id`, `GET /api/upload-history/:id/excluded`,
`POST /api/upload-history` (written by the step after the importer answered; the user and
time come from the session and the server, never from the request).

## Files

New: `apps/api/src/config/importFilterStep.ts`, `apps/api/src/domain/importFilterCheck.ts`, `apps/api/src/domain/importFilterAi.ts`,
`apps/api/src/domain/importFilterUsed.ts`, `apps/api/src/domain/uploadHistory.ts`,
`apps/api/src/http/routes/importFilter.ts`, `apps/api/src/http/routes/uploadHistory.ts`,
`prisma/migrations/0037_upload_history/{migration.sql,down.sql}`, `apps/web/src/lib/importFilter.ts`,
`apps/web/src/lib/uploadHistory.ts`, `apps/web/src/lib/importFilterAi.ts`, `apps/web/src/components/ImportFilterStep.tsx`,
`apps/web/src/components/DataQualityParts.tsx` (score bar + row table shared with Data Quality),
`apps/web/src/components/ImportFilterFlows.tsx`, `apps/web/src/pages/UploadHistory.tsx`; tests
`apps/api/test/{importFilterCheck,importFilterHttp,importFilterUsed,importFilterAi,uploadHistoryHttp}.test.ts`,
`apps/api/test/fakePrismaPlus.ts`, `apps/web/test/{importFilterStep,importFilterExclusions,uploadHistoryPage,dataQualityPageSnapshot}.test.tsx`.

Hook-ins: `prisma/schema.prisma` (the `UploadHistory` model only), `apps/api/src/http/app.ts` (2 route lines),
`.env.example`, `apps/web/src/App.tsx` (1 route), `apps/web/src/components/Layout.tsx` (menu item, only with
the flag on), `apps/web/src/pages/DataQuality.tsx` (`FilterPanel`, `CheckGroup` exported, with optional
`scoreLocked` / `disabled` it never sets; score bar and table moved to `DataQualityParts.tsx`, same HTML),
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
- [ ] Set a row's `createdAt` more than 30 days back → it is gone on the next list / detail request.
- [ ] Data Quality page: upload a file → same score bar, filters, tabs and table as before.
- [ ] Editor account sees the page and every upload.
