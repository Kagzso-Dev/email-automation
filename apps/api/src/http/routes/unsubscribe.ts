import { Router } from "express";
import { randomBytes } from "node:crypto";
import { prisma } from "../../prisma.js";
import { logger } from "../../logger.js";
import { parseUnsubscribeToken } from "../../render/unsubscribe.js";
import { wrap } from "../errors.js";

export const unsubscribeRouter = Router();

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#1b1f2a;line-height:1.6}
h1{font-size:1.3rem}button{font:inherit;padding:.6rem 1rem;border-radius:8px;border:1px solid #ccd2dc;background:#fff;cursor:pointer}
.ok{color:#2f7d5d}</style></head><body>${body}</body></html>`;
}

unsubscribeRouter.get(
  "/preview",
  wrap(async (_req, res) => {
    res.type("html").send(page("Unsubscribe preview", "<h1>Unsubscribe</h1><p>This is a preview link.</p>"));
  }),
);

unsubscribeRouter.get(
  "/:token",
  wrap(async (req, res) => {
    const contactId = parseUnsubscribeToken(req.params.token);
    if (!contactId) return res.status(400).type("html").send(page("Invalid link", "<h1>Invalid unsubscribe link</h1>"));
    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    if (!contact) return res.status(404).type("html").send(page("Not found", "<h1>Contact not found</h1>"));

    res.type("html").send(
      page(
        "Unsubscribe",
        `<h1>Unsubscribe ${escape(contact.email)}</h1>
         <p>Confirm to stop receiving all email from us.</p>
         <form method="POST" action="/api/unsubscribe/${req.params.token}">
           <button type="submit">Unsubscribe me</button>
         </form>`,
      ),
    );
  }),
);

unsubscribeRouter.post(
  "/:token",
  wrap(async (req, res) => {
    const contactId = parseUnsubscribeToken(req.params.token);
    if (!contactId) return res.status(400).type("html").send(page("Invalid link", "<h1>Invalid link</h1>"));
    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    if (!contact) return res.status(404).type("html").send(page("Not found", "<h1>Not found</h1>"));

    await prisma.$transaction([
      prisma.contact.update({ where: { id: contactId }, data: { status: "UNSUBSCRIBED" } }),
      prisma.unsubscribe.upsert({
        where: { contactId },
        create: {
          contactId,
          reason: typeof req.body?.reason === "string" ? req.body.reason : null,
          token: `${req.params.token.slice(0, 40)}-${randomBytes(6).toString("hex")}`,
        },
        update: {},
      }),
    ]);
    logger.info({ contactId }, "contact unsubscribed");
    res.type("html").send(page("Unsubscribed", `<h1 class="ok">You're unsubscribed</h1><p>${escape(contact.email)} will no longer receive email from us.</p>`));
  }),
);

function escape(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}
