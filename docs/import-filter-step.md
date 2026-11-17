# Import filter step (`ENABLE_IMPORT_FILTER_STEP`)

Before **Import file** imports anything on **WhatsApp Contacts** or **Voicecall Contact** (English, Tamil and
every other language page), the file's rows open in the Data Quality filter view. Only **Import N selected**
sends the chosen rows to that page's existing importer. Email Contacts is not affected.

## Switch it on / off

| `.env` (API) | Behaviour |
|---|---|
| `ENABLE_IMPORT_FILTER_STEP=true` | Filter step on both pages |
| unset, blank, `false` (default) | **Import file works exactly as before** |

Restart the API after changing it (PM2: restart the API process). No web rebuild is needed: the web app asks
`GET /api/import-filter/config`. No database migration.

**Rollback:** set `ENABLE_IMPORT_FILTER_STEP=false` (or remove it) and restart the API. To remove the code
entirely, delete the new files below and revert the hook-in lines in the five existing files.

## What happens

1. **WhatsApp Contacts:** picking a file opens the filter step. The file is read with the WhatsApp
   importer's own column names and phone rule (first 1,000 rows, as the importer).
   **Voicecall Contact:** Choose file → column mapping (as today) → **Next: filter N valid rows**.
2. Each row is checked with the Data Quality rules: check status, rules score, tier, phone type, do-not-call /
   not interested / wrong person, already saved. The **AI score is not used** (it needs a saved Data Quality job).
3. Default filters: WhatsApp = Phone type **Mobile** only; Voicecall = **Mobile + Landline**. Language (from
   the script of the name and business: Tamil / English / Other Indian / Not detected) = all ticked on both.
   Every checkbox can be changed; **Clear filters** removes them all.
4. **Approve / Reject by score** and **Only show rows scoring N+** work as on Data Quality, but in memory only:
   rejected rows are left out of the import.
5. **Import N selected** (live count, disabled at 0, never above 1,000) sends the rows that are shown, ticked,
   not rejected, and that the importer takes:
   - WhatsApp: the chosen rows, with all their original columns, as `<file>-selected.csv` to the unchanged
     `POST /api/whatsapp/contacts/import`. A number already saved is updated (the importer's rule; the step
     shows "Already saved: the import updates it"). Numbers WhatsApp can't use (e.g. Indian landlines) can be
     shown but not selected.
   - Voicecall: the chosen mapped rows to the unchanged `POST /api/ai-call-customers/import?language=…`
     (or `/import-to-languages` when an admin picked other lists). Rows with errors or a repeated number are
     not selectable (skipped, as today).
6. Summary: imported, failed, duplicates, **Filtered out**, and the 1,000-row limit.
7. **Back** returns to file selection. Nothing is imported.

**Nothing is saved before the final click.** The new endpoints only read existing tables. The uploaded
temp file is deleted at once (as in the importers). The rows are held in the browser.

## Access

Signed-in ADMIN and EDITOR (both can import today). The Data Quality page itself stays admin-only.

## Files

New: `apps/api/src/config/importFilterStep.ts`, `apps/api/src/domain/importFilterCheck.ts`,
`apps/api/src/http/routes/importFilter.ts`, `apps/web/src/lib/importFilter.ts`,
`apps/web/src/components/ImportFilterStep.tsx`, `apps/web/src/components/ImportFilterFlows.tsx`,
tests `apps/api/test/importFilterCheck.test.ts`, `apps/api/test/importFilterHttp.test.ts`,
`apps/web/test/importFilterStep.test.tsx`.

Hook-ins: `apps/api/src/http/app.ts` (1 route line), `.env.example`, `apps/web/src/pages/DataQuality.tsx`
(`FilterPanel`, `CheckGroup` exported; no behaviour change), `apps/web/src/pages/WhatsAppContacts.tsx`,
`apps/web/src/components/AiCallCustomersPanel.tsx`.

## Manual test checklist

Use a throwaway database. Prepare a CSV with: 2 mobiles, 1 Indian landline (044…), 1 number already in
WhatsApp Contacts, 1 repeated number, 1 do-not-call number, 1 Tamil name, and 1,005 rows for the limit test.

**Flag OFF (regression)**
- [ ] WhatsApp Contacts → Import file → imports at once; summary card as before.
- [ ] Voicecall (English) → Import file → Choose file → button says "Import N valid rows" → imports as before.
- [ ] Voicecall (Tamil `/ta/…`) → same as English; customers land in the Tamil list.
- [ ] Data Quality page: upload, filters, Approve / Reject by score, exports unchanged.
- [ ] Email Contacts import, Send Queue unchanged.

**Flag ON: WhatsApp Contacts**
- [ ] Pick the file → filter view opens; only Phone type **Mobile** ticked; all 4 languages ticked.
- [ ] "Showing X of Y" and "Import N selected" update live; the landline is hidden until Landline is ticked,
      then shows "No usable WhatsApp number" with no checkbox.
- [ ] Saved number shows "Already saved: the import updates it".
- [ ] 1,005-row file: the over-limit note shows; "Import N selected" never exceeds 1,000.
- [ ] Untick all → "Import 0 selected" is disabled.
- [ ] Back → file picker opens; the contact list is unchanged.
- [ ] Close (×) → nothing imported.
- [ ] Import → summary with Filtered out; only the chosen rows are added / updated.

**Flag ON: Voicecall Contact (English, then Tamil)**
- [ ] Choose file → mapping → "Next: filter N valid rows".
- [ ] Mobile + Landline ticked, all languages ticked; the repeated number shows "skipped, as today".
- [ ] Approve / Reject by score; rejected rows drop out of the count.
- [ ] Import → only chosen rows saved, in this page's language list; do-not-call numbers saved as "Do not call".
- [ ] Admin with "Also import into other languages" ticked → per-language table after import.
- [ ] Back → "Choose file"; nothing imported.
- [ ] Editor account can use the step.
