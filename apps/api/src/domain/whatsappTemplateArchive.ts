// Archived WhatsApp templates: hidden from the WhatsApp Templates page (unless
// "Show archived" is on) and from the Send dialog, but never deleted — their
// rows, batches and messages stay, so Send Queue history keeps its names.
//
// Stored as a JSON list of template ids in the generic settings table (no
// schema change). Unknown / deleted ids in the list are harmless.

import { getSetting, setSetting } from "./settings.js";

export const WHATSAPP_TEMPLATES_ARCHIVED_KEY = "whatsapp_templates_archived";

export async function getArchivedTemplateIds(): Promise<Set<string>> {
  const raw = await getSetting<unknown>(WHATSAPP_TEMPLATES_ARCHIVED_KEY, []);
  return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
}

/** Add (archive) or remove (restore) one template id. Returns the new list size. */
export async function setTemplateArchived(id: string, archived: boolean): Promise<number> {
  const ids = await getArchivedTemplateIds();
  if (archived) ids.add(id);
  else ids.delete(id);
  await setSetting(WHATSAPP_TEMPLATES_ARCHIVED_KEY, [...ids].sort());
  return ids.size;
}
