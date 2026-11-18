# Template drafts (`ENABLE_TEMPLATE_DRAFTS`)

If you start a **New template** on **Templates** (email) or on **WhatsApp Templates → New template → Create in
Meta**, and leave before you create it, your work is saved as a draft. It shows on that page's **Drafts** tab,
where you can resume or delete it. Admins only, the same as creating a template.

A draft is never a template. It is never submitted to Meta, never shown in a send flow, and never counted as a
template. Drafts live in their own table (`template_drafts`) and nothing else reads it.

## Switch it on / off

| `.env` (API) | Behaviour |
|---|---|
| `ENABLE_TEMPLATE_DRAFTS=true` | Drafts on both pages: auto-save, Drafts tab, "Continue your draft?" |
| unset, blank, `false` (default) | **Both templates pages work exactly as before.** `/api/template-drafts` answers 404, except `GET /config`, and the 30-day sweep touches nothing |

Restart the API after changing it (PM2: restart the API process). No web rebuild is needed: the web app asks
`GET /api/template-drafts/config`. If that request fails, the web app treats the feature as off.

**Database:** migration **0039_template_drafts** adds one new table, `template_drafts`. It alters no existing
table and has no foreign key. Run `npm run prisma:deploy`. Until the migration is applied, the drafts endpoints
answer **503** with that instruction. The form shows "Draft not saved", the Drafts tab shows the message, and
**creating templates still works**.

## Rollback

1. Set `ENABLE_TEMPLATE_DRAFTS=false` (or remove it) and restart the API. Both pages are exactly as before. Saved
   drafts stay in the table untouched (the sweep is off too), so turning the flag back on brings them back.
2. Optional, to remove the table and every draft: run `prisma/migrations/0039_template_drafts/down.sql` by hand,
   then `DELETE FROM _prisma_migrations WHERE migration_name = '0039_template_drafts';`. No other table is touched.

## What happens

- **Auto-save:** a draft is saved 3 seconds after the last change. It is also saved when you leave the form: when
  you close the editor or the dialog, go to another page, hide the tab, refresh, or close the tab. Refreshes and
  closed tabs use a `keepalive` request, which the browser finishes after the page is gone.
- **Empty forms:** a form that still looks the way **New template** opened it is never saved. That includes a
  change you typed and then undid.
- **Indicator:** "Draft saved 10:42" appears in the form header (in the dialog title on WhatsApp). If a save
  fails, the form shows "Draft not saved". There is no toast, and **Create / Submit to Meta always work**.
- **What's saved:** the whole form, exactly as it is, with no template validation. Validation runs only when you
  create the real template, as before.
  - **Email:** name, letter or meeting, subject, declared variables, message, signature, images (URLs; uploads are
    URLs already), videos, plain-text body, links and meeting details.
  - **WhatsApp:** name, Meta name, category, language, header type and text, body, variables (the field each one
    fills and its example), footer and buttons.
  - **A header image, video or document file can't be kept.** Its name is saved. When you resume, the form asks you
    to attach the file again, and Submit stays blocked until you do, as it does today.
- **Drafts tab:** shows a count badge and lists the drafts newest first. Each row has the name (or "Untitled
  draft"), the owner, and when it was last edited (plus who edited it, if that wasn't the owner). Each row has
  **Resume** and **Delete**, and Delete asks for confirmation. Every admin sees the team's drafts and can resume or
  delete any of them. The footer says drafts are deleted after 30 days.
- **Resume** opens the create form filled in from the draft. If another user edited the draft in the last 10
  minutes, you are warned first ("If you both keep editing, the last save wins"). The last save always wins.
- **"Continue your draft?":** when you click **New template** and have a draft of your own on that page, edited in
  the last 7 days, you can choose **Continue draft** or **Start new**. Start new keeps the old draft.
- **Creating the template deletes its draft.** If the create fails (validation, or Meta rejects it), the draft is
  kept.
- **Only new templates have drafts.** Editing an existing template, and WhatsApp **Register existing**, work as
  before.
- **30 days:** a draft not edited for 30 days is deleted. This runs when the list is read and in an hourly sweep
  in the API process (flag on only).

## API

All endpoints need sign-in. All except `/config` are ADMIN only and answer 404 when the flag is off.

| Endpoint | |
|---|---|
| `GET /api/template-drafts/config` | `{ enabled }`, for any signed-in user |
| `GET /api/template-drafts?channel=email\|whatsapp` | `{ items, retentionDays }`, newest first, without the form state |
| `GET /api/template-drafts/:id` | one draft with its `state` |
| `PUT /api/template-drafts/:id` | create or update `{ channel, name, state }` (last write wins). The browser makes the id (a UUID). The owner is set on create. The last editor and the time come from the session and the server clock. `state` can be up to 256 KB |
| `DELETE /api/template-drafts/:id` | 204, or 404 |

## Files

| File | |
|---|---|
| `apps/api/src/config/templateDrafts.ts` | reads the flag (never throws) |
| `apps/api/src/domain/templateDrafts.ts` | the only code that reads or writes `template_drafts`; the 30-day purge and the hourly sweep |
| `apps/api/src/http/routes/templateDrafts.ts` | the endpoints (404 when off, 503 before the migration) |
| `apps/web/src/lib/templateDrafts.ts` | the flag, the API calls, `useDraftAutosave` |
| `apps/web/src/components/TemplateDrafts.tsx` | "Draft saved" note, Drafts tab, "Continue your draft?" and the 10-minute warning |
| `prisma/migrations/0039_template_drafts/` | `migration.sql` (up) and `down.sql` (manual rollback) |

Existing files, additive only: `prisma/schema.prisma` (the `TemplateDraft` model), `apps/api/src/http/app.ts`
(mount the router), `.env.example` (the flag), `apps/web/src/pages/Templates.tsx`,
`apps/web/src/pages/WhatsAppTemplates.tsx`, `apps/web/src/components/WhatsAppTemplateCreate.tsx`, and
`apps/web/src/components/ui.tsx` (`Tabs` labels and `Modal` titles accept a `ReactNode`, so the Drafts tab can
show a count badge and the dialog title can show the note; a type change only).

Tests: `apps/api/test/templateDraftsHttp.test.ts`, `apps/web/test/templateDraftsEmail.test.tsx`,
`apps/web/test/templateDraftsWhatsApp.test.tsx`, `apps/web/test/templateDraftsFlagOff.test.tsx`.

## Manual test checklist

Use a throwaway database for local checks. Sign in as an **admin**.

**Flag off (default)**

- [ ] Templates and WhatsApp Templates look as before: no Drafts tab.
- [ ] **New template** opens at once on both pages, with no "Continue your draft?".
- [ ] Type in a new template and wait 5 s: no "Draft saved". In DevTools → Network, the only template-drafts
  request is `GET /api/template-drafts/config`.
- [ ] Create an email template and submit a WhatsApp template to Meta: both work as before.

**Flag on, before the migration**

- [ ] The Drafts tab says to run `npm run prisma:deploy` (migration 0039).
- [ ] Typing in a new template shows "Draft not saved", and **Create** still works.

**Flag on, migration applied**

- [ ] Email: New template, type a name and subject, and wait about 3 s. The header shows "Draft saved HH:MM".
  The Drafts tab count goes to 1.
- [ ] Email: open New template and close it without typing. No draft appears.
- [ ] Email: type, then within 3 s click another template in the list. The draft has your last keystrokes.
- [ ] Email: type, then within 3 s refresh the browser. The draft has your last keystrokes.
- [ ] Email: type, then switch to the Drafts tab and back. The open form still has your text.
- [ ] Email: in the Drafts tab, click Resume. Every field is back, including meeting details, links, images,
  videos and variables.
- [ ] Email: click Create. The template is created and the draft is gone from Drafts.
- [ ] WhatsApp: New template → Create in Meta. Type the name, change the category and language, add a text header,
  body variables with examples, a footer and URL / phone buttons, then close the dialog. Resume restores all of it.
- [ ] WhatsApp: pick an image header and attach a file. On Resume, "Attach the file again" shows, and Submit asks
  for the file.
- [ ] WhatsApp: Submit to Meta successfully. The draft is deleted. Make Meta reject one (for example a duplicate
  name). The draft stays.
- [ ] WhatsApp: Register existing never creates a draft.
- [ ] With a draft of your own, click New template. "Continue your draft?" appears. Continue draft opens it.
  Start new opens a blank form and keeps the draft.
- [ ] As a second admin, open the Drafts tab. You see the first admin's draft with their email as owner.
- [ ] As the second admin, resume a draft the first admin edited less than 10 minutes ago. You get the warning.
  Resume anyway works.
- [ ] Delete asks first. Cancel keeps the draft, Delete removes it.
- [ ] Neither the email send dialogs (Campaigns, Triggers, manual send) nor the WhatsApp Send dialog list any
  draft.
- [ ] Sign in as an editor: the templates pages are hidden, as before. `GET /api/template-drafts` answers 403.
- [ ] 30 days: in the throwaway database, set a draft's `updatedAt` to 31 days ago, then open the Drafts tab. It
  is gone.
