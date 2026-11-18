# Image size controls (`ENABLE_IMAGE_SIZE_CONTROLS`)

Templates → **Images (optional)** gets a Gmail-style toolbar under each image:

**Small | Best fit | Original size | Edit alt text | Remove**

The chosen size is highlighted and the live size is shown on the right (for example "Best fit · 600 px").
Preview, Send test and real sends all use the same renderer, so they look the same.

No database change: the settings are stored in the existing `templates.images` JSON.

## Switch it on / off

| `.env` | Result |
|---|---|
| `ENABLE_IMAGE_SIZE_CONTROLS=true` (also `1`, `yes`, `on`) — the value in `.env.example` | Toolbar shown; emails use each image's size and alt text |
| `false`, empty, anything else, or the line missing | The Images section and every email are exactly as before |

`.env.example` ships with `true`. An existing `.env` without the line (for example production) stays off until
the line is added.

Restart the **API and the worker** after changing it. Real sends are rendered in the worker, so restarting only
the API leaves real sends on the old setting. On the Vultr server, restart both kagzso-automation PM2
processes. The web app reads the flag from `GET /api/image-size-controls/config`. Loading, an error, or an older
API without that endpoint all count as OFF.

## Rollback

1. **Normal rollback:** set `ENABLE_IMAGE_SIZE_CONTROLS=false` (or remove it) and restart the API and the worker.
   Every email renders exactly as before. Stored sizes and alt texts stay in the data, unused, and come back if
   the flag is switched on again. Nothing else to do.
2. **Only if you revert the code:** code from before this feature only understands plain image URLs. First run
   `npm run images:strip-sizes:plan` (dry run, writes nothing). Then run `npm run images:strip-sizes`, which turns
   each `{ url, size, … }` back into its URL. It saves the old JSON in `restore-logs/` and prints the undo command
   (`npm run images:strip-sizes -- --undo <file>`). After that, revert the code.

There is no migration, so there is nothing to roll back in the database.

## What is stored

Each entry in `templates.images` is either:

- a plain URL string. Every image saved before the feature is one, and so is any image nobody has touched since.
- `{ url, size?, alt?, naturalWidth?, name? }`. An image becomes this only when someone picks a size or types an
  alt text.
  - `size` is `small`, `fit` or `original`. If it's missing, the image renders exactly as before.
  - `naturalWidth` is the image's own width, read in the browser.
  - `name` is the original upload file name, used for the alt fallback.

New images start at **Best fit** while the flag is on. Placeholders `{{image}}`, `{{image_2}}`, `{{image_3}}` …
work exactly as before, and images with no placeholder still come last. The plain-text version is unchanged
(`Image: <url>`).

## Rendering (flag on)

Each image keeps the same wrapper as before, `<div style="margin:16px 0">`. Its tag gets a `width="…"` attribute,
which Outlook on desktop uses because it ignores CSS `max-width`. It also gets inline CSS:
`display:block;border:0;height:auto;` + the size rule below + `border-radius:8px`. No `<style>` blocks or classes,
so Gmail, Outlook and Apple Mail keep it.

| Size | Width known (W) | Width unknown |
|---|---|---|
| Small | `width="min(200,W)"` · `width:min(200,W)px;max-width:100%` | `width="200"` · `width:200px;max-width:100%` |
| Best fit | `width="min(W,600)"` · `width:100%;max-width:min(W,600)px` | no width attribute · `max-width:100%` |
| Original size | `width="W"` · `width:Wpx;max-width:100%` | same as Best fit |
| (no size: images saved before) | exactly as before | exactly as before |

- **Never enlarged:** no size ever shows an image wider than its own width, so a small QR code or logo never blurs.
- **Phones:** `max-width:100%` scales every size down to fit the screen.
- **Best fit** fills a 600px email column, the usual email width.
- **Original size** keeps the image's real width. For an image wider than 600px, the toolbar warns that Outlook on
  desktop will show it at full width.

**Alt text** is HTML-escaped, can hold `{{variables}}`, and has a 125-character limit. If it's empty, the email
uses the original upload file name, then the file name in the URL (for example `photo.jpg`), then `Image`. Images
with no size set keep `alt=""` unless an alt text is typed.

**Width detection:** for uploads, the width is read from the file before it's uploaded; the upload API is
unchanged. For pasted URLs, it's read from the row's thumbnail once it loads. When the width can't be read (a
broken link, or a `{{variable}}` in the URL), it's left unknown and the fallbacks above apply.

## Files

- New:
  - `packages/shared/src/templateImages.ts`: schema plus the size and alt rules, shared by the editor and the
    renderer.
  - `apps/api/src/config/imageSizeControls.ts`
  - `apps/api/src/http/routes/imageSizeControls.ts`
  - `apps/api/src/render/imageSize.ts`
  - `apps/web/src/lib/imageSizeControls.ts`
  - `apps/web/src/components/ImageSizeToolbar.tsx`
  - `prisma/stripImageSizes.ts`
- Changed:
  - `packages/shared/src/schemas.ts`: an `images` entry can now be a URL or an object.
  - `packages/shared/src/index.ts`
  - `apps/api/src/render/render.ts`: reads entries and picks the renderer by the flag.
  - `apps/api/src/render/meeting.ts`: `safeImgSrc` is exported.
  - `apps/api/src/http/app.ts`
  - `apps/web/src/pages/Templates.tsx`
  - `.env.example`
  - `package.json`
- Unchanged: the template routes, upload, delivery, inline images, sending, suppression, auth and roles.

## Tests

- `apps/api/test/imageLegacyRender.test.ts`: byte-for-byte snapshots recorded **before** the feature, for every
  existing image shape, checked with the flag unset, false and true.
- `apps/web/test/templateImagesFlagOff.test.tsx`: the Images section markup and the Save payload, recorded before
  the feature, checked with the flag off and with the config endpoint failing.
- `apps/api/test/imageSizeControls.test.ts`:
  - every size and width
  - alt escaping and fallbacks
  - placeholders and order
  - plain text unchanged
  - flag off ignores stored settings
  - schema limits
  - the config endpoint
- `apps/web/test/templateImageSize.test.tsx`:
  - the toolbar, highlight and live size
  - Remove
  - editors are view only
  - alt text
  - width from the thumbnail (pasted URL) and from the file (upload)
  - untouched images saved as plain URLs

## Manual test checklist

Set `ENABLE_IMAGE_SIZE_CONTROLS=true`, then restart the API and the worker.

**Editor**

1. Open an existing template that has images. Each image shows the toolbar, no size is highlighted, and the label
   says "Size: as before". Click **Save** without changing anything, then **Preview**. The email looks exactly as
   before.
2. **+ Add image**, paste a photo URL wider than 600px. Best fit is highlighted and the label shows `Best fit · 600 px`.
3. **+ Add image**, upload a small QR code (for example 150px). The label shows `Best fit · 150 px`. Click
   **Original size**: `Original size · 150 px`. Click **Small**: `Small · 150 px`.
4. **Edit alt text**: the "Alt text" box stops at 125 characters and the counter updates. Clear it, and the note
   shows the fallback (the file name, or "Image").
5. **Remove** in the toolbar removes the row, the same as the X.
6. Sign in as an editor. The toolbar buttons are greyed out (view only).

**Send a test with each size**

Make one template with four images: a wide photo on Small, the same photo on Best fit, a 900px chart on Original
size, and a small QR code on Best fit. Put one at `{{image}}` and leave the others unplaced. Save it, then use
**Send test to** for each of these:

| Check | Gmail (web) | Outlook (desktop, Windows) | Outlook.com | Phone (Gmail app / iOS Mail) |
|---|---|---|---|---|
| Small photo is about 200px wide | ☐ | ☐ | ☐ | ☐ |
| Best fit photo is about 600px wide, not wider | ☐ | ☐ | ☐ | ☐ fills the screen width |
| Original chart is 900px (narrower window: shrinks) | ☐ | ☐ 900px | ☐ | ☐ fits the screen |
| QR code is NOT enlarged or blurry | ☐ | ☐ | ☐ | ☐ |
| No horizontal scrolling | ☐ | ☐ (except Original wider than the window) | ☐ | ☐ |
| `{{image}}` image is in the right place; the rest come last | ☐ | ☐ | ☐ | ☐ |
| Alt text appears when images are blocked / not loaded | ☐ | ☐ | ☐ | ☐ |
| Plain-text part still lists `Image: <url>` | ☐ (Show original) | ☐ | ☐ | — |

**Flag off**

Set `ENABLE_IMAGE_SIZE_CONTROLS=false` and restart the API and the worker. The toolbar is gone. Send the same test
again: every image looks as it did before the feature, and the settings are still there when the flag is turned
back on.
