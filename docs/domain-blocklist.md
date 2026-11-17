# Email domain blocklist (Settings → Domain mode)

One switch in Settings, **"Email all domains except blocked ones"**, chooses which recipient domains may be emailed:

| Switch | Mode | Who is emailed |
|---|---|---|
| OFF (default) | ALLOWLIST | Only domains on **Approved sending domains**. An empty Approved list means no restriction. Exact match. This is the behaviour from before the feature. |
| ON | BLOCKLIST | Every domain except those on **Blocked domains**. A blocked entry also blocks its subdomains (`mailinator.com` blocks `eu.mailinator.com`, not `notmailinator.com`). Invalid or missing addresses are skipped. An empty Blocked list emails everyone, and Settings shows a warning when it's empty. |

Whatever the switch says, **unsubscribed, bounced and complained contacts are never emailed**. That check (`domain/suppression.ts`) always runs first, and nothing in this feature changes it.

Matching is case-insensitive. The same rule runs at import, on manual add/edit, and again at send time, so switching the mode applies straight away to contacts that are already saved.

The switch is a UI-level toggle: admins turn it on in Settings, with no `.env` change. It starts OFF on every install, so nothing changes until an admin switches it. `ENABLE_DOMAIN_BLOCKLIST` is only a kill switch. Leave it empty (the default) to keep the switch in Settings. Set it to `false` to hide the switch and force the Approved list: the stored mode and the new tables are then never read, and the app behaves exactly as before.

## Turning it on

1. Apply migration `0036_sending_domain_blocklist`: `npm run prisma:deploy`. It only creates two new tables, `blocked_sending_domains` and `sending_domain_audit`. Until it is applied, Settings shows the switch disabled, with a note saying to run this.
2. Restart the API and the worker if they were running when the code was deployed.
3. In Settings → **Domain mode**, an admin turns on "Email all domains except blocked ones" and confirms the warning.

Only admins can flip the switch or edit either list. Every change records who made it and when, in `sending_domain_audit`. Admins can read the log under Settings → Domain mode → *Recent changes*. While the flag is on, Approved-list changes are logged too.

## Where the rule runs

| Path | File | When refused |
|---|---|---|
| Contacts → Import file | `queue/contactImport.ts` | Row skipped. In BLOCKLIST mode the summary says "X skipped: blocked domain". |
| Manual add / edit contact | `http/routes/contacts.ts` | 400 "Email domain is on the blocked sending list: …" (BLOCKLIST) or the old message (ALLOWLIST) |
| Every send (campaigns, triggers, manual, Send Queue drip) | `domain/delivery.ts` → `isEmailDomainAllowed` | Ledger `FAILED`, reason "domain blocked" (BLOCKLIST) or "domain not approved" (ALLOWLIST) |
| Manual send, Send Queue batch eligibility | `domain/manualSend.ts` | Item `SKIPPED`, "email domain is on the blocked sending list" (BLOCKLIST) or the old text |

The rule itself is in `domain/sendingDomainPolicy.ts`, and the mode lives in the `Setting` row `sendingDomainMode`. WhatsApp and Voicecall are not affected.

## Rollback

From quickest to most complete. No step deletes contacts, and none touches the Approved list.

1. **Turn the switch OFF** in Settings, as an admin. This takes effect on the next import or send.
2. **Kill switch:** set `ENABLE_DOMAIN_BLOCKLIST=false` and restart the API and the worker. The stored mode is ignored, the switch disappears, and `/api/settings/sending-domains` answers 404 (except GET, which says `{ enabled: false }`). Everything is exactly as before.
3. **Remove the data:** after step 2, run `prisma/migrations/0036_sending_domain_blocklist/down.sql` by hand. It drops both new tables and the stored mode. Then remove the migration from Prisma's history:
   `DELETE FROM _prisma_migrations WHERE migration_name = '0036_sending_domain_blocklist';`

Contacts imported while BLOCKLIST was on stay in Email Contacts. After a rollback, if the Approved list has entries, those contacts are skipped at send time ("domain not approved") unless their domain is approved.

## Manual test checklist

Use a throwaway database (see the local real-app check notes), with `EMAIL_PROVIDER=mock`.

**Kill switch on (`ENABLE_DOMAIN_BLOCKLIST=false`)**
- [ ] Settings looks as before: there is no Domain mode section, and the Approved list reads as it always has.
- [ ] With `ok.com` approved, importing a file that has `a@ok.com` and `b@other.com` imports only `a@ok.com`, and the summary says "1 with an email domain not on the approved list (Settings)".
- [ ] Sending to an existing `b@other.com` contact is skipped as "domain not approved".

**Default (`ENABLE_DOMAIN_BLOCKLIST` empty), switch OFF**
- [ ] Before `npm run prisma:deploy`: Domain mode shows the switch disabled, with a note to run it.
- [ ] After it: Domain mode appears with the switch OFF. The Blocked list is hidden and the Approved list is active.
- [ ] The import and send results are the same as with the kill switch on.

**Turning it ON**
- [ ] Clicking the switch asks "All domains will be emailed except blocked ones. This may affect deliverability." Cancel leaves it OFF.
- [ ] Confirming turns it ON. "Last changed by <you> on <date>" appears.
- [ ] The Blocked domains section appears with the warning "The blocked list is empty, so every domain is emailed."
- [ ] The Approved list is greyed out with an **Inactive** badge, and its domains are still listed.
- [ ] Clicking the `mailinator.com` suggestion fills the box but adds nothing. "Block domain" adds it, and the empty-list warning goes away.
- [ ] Adding `MailInator.com` again is refused as already blocked. Adding `not a domain` is refused as invalid.

**Switch ON: behaviour**
- [ ] Import a file with `c@gmail.com`, `x@mailinator.com`, `y@eu.mailinator.com`, `z@notmailinator.com`, `bad@nodot` and a row with no email. `c@` and `z@` are imported. The summary says "2 skipped: blocked domain" and "2 without a valid email address".
- [ ] Sending to `b@other.com` (saved earlier and not approved) now goes out. Sending to a saved `x@mailinator.com` is skipped as "domain blocked".
- [ ] Mark a contact at an allowed domain UNSUBSCRIBED, then BOUNCED, then COMPLAINED. It is never emailed: manual send, Send Queue and campaign all skip it.
- [ ] A Send Queue batch that includes a blocked contact shows it as SKIPPED with "email domain is on the blocked sending list".
- [ ] Manually adding `x@mailinator.com` is refused with "Email domain is on the blocked sending list".

**Switching back OFF, and permissions**
- [ ] Turning it OFF takes effect at once, with no prompt. `b@other.com` is skipped again as "domain not approved".
- [ ] Recent changes lists each switch and list change with the admin's email and the time.
- [ ] As an editor, the switch is visible but disabled, there is no add box, and calling the API directly answers 403.

## Tests

- `apps/api/test/sendingDomainPolicy.test.ts`: the rule in both modes (allowed, blocked, invalid, missing, uppercase, subdomains, look-alikes), which tables are read with the flag off and on, and the wording.
- `apps/api/test/sendingDomainSend.test.ts`: delivery, manual send, Send Queue eligibility and import, end to end with the flag off, in ALLOWLIST and in BLOCKLIST, with suppression in every mode.
- `apps/api/test/sendingDomainsHttp.test.ts`: admin-only changes, 404 with the flag off, the audit log, Approved-list auditing, and manual add/edit.
- `apps/web/test/sendingDomainMode.test.tsx`: the switch, the confirmation, the Inactive Approved list, the empty-list warning, the suggestions, the editor view and the import summary.
