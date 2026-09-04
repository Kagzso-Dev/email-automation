import type { Contact } from "@prisma/client";
import type { RenderVars } from "../render/render.js";

/** Flattens a contact + optional event payload into template variables. */
export function buildVars(contact: Contact, payload?: Record<string, unknown>): RenderVars {
  const custom = (contact.customFields ?? {}) as Record<string, unknown>;
  const vars: RenderVars = {
    email: contact.email,
    first_name: contact.firstName ?? "",
    last_name: contact.lastName ?? "",
    full_name: [contact.firstName, contact.lastName].filter(Boolean).join(" "),
    phone: contact.phone ?? "",
    business_name: contact.businessName ?? "",
    status: contact.status,
  };
  for (const [k, v] of Object.entries(custom)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") vars[k] = v;
  }
  if (payload) {
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        vars[`payload.${k}`] = v;
        if (!(k in vars)) vars[k] = v;
      }
    }
  }
  return vars;
}
