// "Filter new data" on the Send Queue page — compare an uploaded file with one
// channel's send history. Read-only: nothing is created, changed or deleted.
//
//   POST /api/send-queue/filter/:channel/analyze    file (+ column) → detected column + summary
//   POST /api/send-queue/filter/:channel/download   file + column + part=new|used → csv / xlsx
//
// :channel is email | whatsapp | ai-call. The file is re-sent for each download,
// so the server keeps no state between calls. ai-call is admin-only and 404s
// while ENABLE_AI_CALLS is off, like the AI Call follow-ups tab.

import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { authRequired } from "../middleware/auth.js";
import { AppError, badRequest, forbidden, wrap } from "../errors.js";
import { aiCallsConfig } from "../../config/aiCalls.js";
import { whatsappConfig } from "../../config/whatsapp.js";
import {
  detectHistoryColumn,
  filterAgainstHistory,
  historyFormatFromFilename,
  readHistoryFile,
  writeHistoryFile,
  HISTORY_CHANNELS,
  type HistoryChannel,
} from "../../domain/historyFilter.js";

export const historyFilterRouter = Router();
historyFilterRouter.use(authRequired);

const MAX_BYTES = 20 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

/** multer's own errors (file too large, wrong field) as a clean 400 instead of a 500. */
const singleFile = (req: Request, res: Response, next: NextFunction) =>
  upload.single("file")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      return next(badRequest(err.code === "LIMIT_FILE_SIZE" ? "File is larger than 20 MB" : err.message));
    }
    next(err as Error | undefined);
  });

const limiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  message: { error: "Too many file checks — wait a minute and try again.", code: "rate_limited" },
});

const channelParam = z.object({ channel: z.enum(HISTORY_CHANNELS as [HistoryChannel, ...HistoryChannel[]]) });

/** Channel gate: AI-call history is admin-only and hidden while AI calls are off. */
function gate(req: Request): HistoryChannel {
  const parsed = channelParam.safeParse(req.params);
  if (!parsed.success) throw new AppError(404, "Unknown channel", "not_found");
  const channel = parsed.data.channel;
  if (channel === "ai-call") {
    if (!aiCallsConfig.enabled) throw new AppError(404, "AI calls are disabled (set ENABLE_AI_CALLS=true)", "not_found");
    if (req.user?.role !== "ADMIN") throw forbidden("Requires role: ADMIN");
  }
  return channel;
}

/** Each channel's own default country code — the one its numbers were stored with. */
const countryCode = (channel: HistoryChannel) =>
  channel === "ai-call" ? aiCallsConfig.defaultCountryCode : channel === "whatsapp" ? whatsappConfig.defaultCountryCode ?? "91" : "91";

async function loadUpload(req: Request) {
  if (!req.file) throw badRequest("File required (multipart field 'file')");
  const format = historyFormatFromFilename(req.file.originalname);
  if (!format) throw badRequest("Unsupported file type — upload a .csv or .xlsx file");
  let grid;
  try {
    grid = await readHistoryFile(req.file.buffer, format);
  } catch {
    throw badRequest("Couldn't read the file — check it is a valid .csv or .xlsx");
  }
  if (grid.headers.length === 0) throw badRequest("The file has no header row");
  return { grid, format, name: req.file.originalname };
}

/** `column` form field: the header index chosen in the picker. */
function pickColumn(raw: unknown, width: number): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n >= width) throw badRequest("Unknown column");
  return n;
}

historyFilterRouter.post(
  "/:channel/analyze",
  limiter,
  (req, _res, next) => (gate(req), next()),
  singleFile,
  wrap(async (req, res) => {
    const channel = gate(req);
    const { grid, format, name } = await loadUpload(req);
    const cc = countryCode(channel);
    const guess = detectHistoryColumn(grid, channel, cc);
    const chosen = pickColumn(req.body?.column, grid.headers.length) ?? guess.column;
    const result = chosen === null ? null : (await filterAgainstHistory(grid, channel, chosen, cc)).summary;
    res.json({
      channel,
      fileName: name,
      format,
      headers: grid.headers,
      column: chosen,
      detected: guess.column,
      ambiguous: guess.ambiguous,
      candidates: guess.candidates,
      summary: result,
    });
  }),
);

historyFilterRouter.post(
  "/:channel/download",
  limiter,
  (req, _res, next) => (gate(req), next()),
  singleFile,
  wrap(async (req, res) => {
    const channel = gate(req);
    const part = z.enum(["new", "used"]).parse(req.body?.part);
    const { grid, format, name } = await loadUpload(req);
    const column = pickColumn(req.body?.column, grid.headers.length);
    if (column === null) throw badRequest("Pick the column to compare");
    const { verdicts, previous } = await filterAgainstHistory(grid, channel, column, countryCode(channel));
    const rows = verdicts.flatMap((v, i) => (v === part ? [i] : []));
    const buf = await writeHistoryFile(
      grid,
      format,
      rows,
      part === "used" ? { header: "Previous status", values: previous } : undefined,
    );
    const base = name.replace(/\.(csv|xlsx)$/i, "").replace(/[^\w.\- ]+/g, "_") || "file";
    const filename = `${base}-${part === "new" ? "new-only" : "already-used"}.${format}`;
    res.setHeader(
      "Content-Type",
      format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
  }),
);
