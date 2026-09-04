import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./icons";

/**
 * A small rule-based help assistant for the Campaigns page. No network calls and
 * no LLM — it matches the visitor's question against a fixed knowledge base and
 * replies with the best-scoring entry (or a menu of topics when nothing matches).
 */

interface Entry {
  id: string;
  /** Lowercase terms that point at this entry. */
  keywords: string[];
  /** Shown as a suggestion chip and echoed as the "asked" bubble. */
  question: string;
  answer: ReactNode;
}

const ENTRIES: Entry[] = [
  {
    id: "start",
    keywords: ["create", "new", "start", "make", "add", "set up", "setup", "begin"],
    question: "How do I create a campaign?",
    answer: (
      <>
        Click <b>New campaign</b>, then pick a name, a <b>template</b>, and a{" "}
        <b>list</b>. Choose <b>One-time</b> (a single date &amp; time) or{" "}
        <b>Recurring</b> (repeats on a schedule), then <b>Create &amp; schedule</b>.
        You need at least one template and a list with contacts first.
      </>
    ),
  },
  {
    id: "validation",
    keywords: [
      "validation",
      "failed",
      "error",
      "invalid",
      "won't save",
      "wont save",
      "cannot save",
      "can't save",
      "not saving",
      "rejected",
    ],
    question: "Why did I get a “Validation failed” error?",
    answer: (
      <>
        The form now shows exactly which field is wrong — check the red note above
        the button and the toast that pops up. The usual causes are: a{" "}
        <b>send time in the past</b>, no <b>template</b> or <b>list</b> chosen, or a
        recurring schedule with no frequency picked. Fix the highlighted field and
        save again.
      </>
    ),
  },
  {
    id: "disabled",
    keywords: [
      "disabled",
      "greyed",
      "grayed",
      "can't click",
      "cant click",
      "button",
      "not working",
      "stuck",
    ],
    question: "The “Create & schedule” button is disabled — why?",
    answer: (
      <>
        It stays disabled when the selected <b>list has no members</b>, or when the
        one-time <b>date &amp; time is in the past</b>. Add contacts to the list or
        pick a future time and it re-enables.
      </>
    ),
  },
  {
    id: "future",
    keywords: ["future", "past", "date", "time", "when", "sendat", "send at", "schedule time"],
    question: "It says the send time must be in the future.",
    answer: (
      <>
        A one-time campaign has to be scheduled for a moment later than right now.
        Bump the date or the time forward a few minutes. If you picked a time only a
        minute ahead and then took a while to submit, that minute may have already
        passed — just pick a later time.
      </>
    ),
  },
  {
    id: "once-vs-recurring",
    keywords: ["recurring", "repeat", "once", "one-time", "one time", "difference", "daily", "weekly", "monthly"],
    question: "What's the difference between one-time and recurring?",
    answer: (
      <>
        <b>One-time</b> sends once, at the date and time you set. <b>Recurring</b>{" "}
        sends on a repeating schedule — Daily, Weekly (pick a weekday), or Monthly
        (pick a day of the month) — at the time you choose. Recurring schedules run
        in the server's timezone (UTC unless changed).
      </>
    ),
  },
  {
    id: "edit",
    keywords: ["edit", "change", "update", "modify"],
    question: "Can I edit a campaign after creating it?",
    answer: (
      <>
        Only while it's in <b>DRAFT</b> or <b>PAUSED</b>. Once it's SCHEDULED,
        SENDING, or SENT the Edit link disappears — pause it first if you need to
        make changes.
      </>
    ),
  },
  {
    id: "run-now",
    keywords: ["run now", "send now", "immediately", "test send", "dispatch", "run"],
    question: "What does “Run now” do?",
    answer: (
      <>
        It dispatches the campaign to <b>every contact on its list right away</b>,
        ignoring the schedule. Only admins see this button, and it asks for
        confirmation first.
      </>
    ),
  },
  {
    id: "delete",
    keywords: ["delete", "remove", "cancel"],
    question: "How do I delete a campaign?",
    answer: (
      <>
        Use the <b>Delete</b> link on its row. You can't delete a campaign while
        it's actively <b>SENDING</b> — wait for it to finish or pause it.
      </>
    ),
  },
  {
    id: "empty-list",
    keywords: ["no members", "empty", "list has no", "contacts", "0 members", "add contacts"],
    question: "My list has no members.",
    answer: (
      <>
        A campaign can't send to an empty list. Open{" "}
        <Link className="text-accent-ink underline" to="/lists">
          Lists
        </Link>
        , add contacts to it, then come back and create the campaign.
      </>
    ),
  },
  {
    id: "status",
    keywords: ["status", "draft", "scheduled", "sending", "sent", "paused", "failed", "what does"],
    question: "What do the campaign statuses mean?",
    answer: (
      <>
        <b>DRAFT</b> — created, not scheduled. <b>SCHEDULED</b> — waiting for its
        send time. <b>SENDING</b> — dispatching now. <b>SENT</b> — finished.{" "}
        <b>PAUSED</b> — you stopped it; edit or reschedule. <b>FAILED</b> — the run
        errored; check the campaign detail page.
      </>
    ),
  },
];

const GREETING: ReactNode = (
  <>
    Hi! I can help with creating, scheduling, and troubleshooting campaigns. Pick a
    question below or type your own.
  </>
);

interface Msg {
  from: "bot" | "user";
  body: ReactNode;
}

function findAnswer(query: string): ReactNode {
  const q = ` ${query.toLowerCase()} `;
  let best: { entry: Entry; score: number } | null = null;
  for (const entry of ENTRIES) {
    let score = 0;
    for (const kw of entry.keywords) if (q.includes(kw)) score += kw.length;
    if (score > 0 && (!best || score > best.score)) best = { entry, score };
  }
  if (best) return best.entry.answer;
  return (
    <>
      I'm not sure about that one. I can help with: creating a campaign,
      one-time vs recurring schedules, why saving fails, editing or deleting a
      campaign, “Run now”, and what the statuses mean.
    </>
  );
}

export function CampaignAssistant({ onNewCampaign }: { onNewCampaign?: () => void }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([{ from: "bot", body: GREETING }]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, open]);

  const suggestions = useMemo(() => ENTRIES.slice(0, 5), []);

  function ask(question: string) {
    setMsgs((m) => [
      ...m,
      { from: "user", body: question },
      { from: "bot", body: findAnswer(question) },
    ]);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    ask(text);
    setInput("");
  }

  return (
    <>
      {open ? (
        <div className="animate-dialog-in fixed bottom-20 right-4 z-40 flex h-[30rem] w-[calc(100vw-2rem)] max-w-sm flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-pop">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-soft text-accent-ink">
                <Icon name="info" size={16} />
              </span>
              <span className="text-sm font-semibold">Campaign help</span>
            </div>
            <button
              type="button"
              aria-label="Close help"
              onClick={() => setOpen(false)}
              className="-m-1.5 grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-surface-muted hover:text-ink"
            >
              <Icon name="close" size={18} />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {msgs.map((m, i) => (
              <div key={i} className={m.from === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={
                    m.from === "user"
                      ? "max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3 py-2 text-sm text-white"
                      : "max-w-[85%] rounded-2xl rounded-bl-sm bg-surface-muted px-3 py-2 text-sm text-ink"
                  }
                >
                  {m.body}
                </div>
              </div>
            ))}

            {msgs.length <= 1 ? (
              <div className="flex flex-wrap gap-2 pt-1">
                {suggestions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => ask(s.question)}
                    className="rounded-full border border-line-strong bg-surface px-3 py-1 text-xs text-slate-550 hover:bg-surface-muted hover:text-ink"
                  >
                    {s.question}
                  </button>
                ))}
                {onNewCampaign ? (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onNewCampaign();
                    }}
                    className="rounded-full border border-accent bg-accent-soft px-3 py-1 text-xs font-medium text-accent-ink hover:bg-accent hover:text-white"
                  >
                    Start a new campaign
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          <form onSubmit={submit} className="flex items-center gap-2 border-t border-line px-3 py-2.5">
            <input
              className="input"
              placeholder="Ask about campaigns…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button type="submit" className="btn-primary shrink-0 px-3" aria-label="Send">
              <Icon name="campaigns" size={16} />
            </button>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close campaign help" : "Open campaign help"}
        className="fixed bottom-4 right-4 z-40 grid h-12 w-12 place-items-center rounded-full bg-accent text-white shadow-pop transition-colors hover:bg-accent-ink"
      >
        <Icon name={open ? "close" : "info"} size={20} />
      </button>
    </>
  );
}
