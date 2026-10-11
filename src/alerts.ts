import { createHash } from "node:crypto";
import type { Finding } from "./types.ts";

// Stage E5 alerts. A finding alerts the first time it appears. Critical
// findings that persist re-alert every `repeatHours`; warnings don't. When
// everything that alerted is gone, one "resolved" message goes out.
// Channels are optional and independent; each one that has its settings
// gets every alert. If a channel fails, the run still finishes (and the
// GitHub Actions job fails, which GitHub also emails about).
//   RESEND_API_KEY + ALERT_EMAIL_FROM + ALERT_EMAIL_TO (comma-separated)
//   ALERT_WEBHOOK_URL   Slack or Discord incoming webhook
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID

export type AlertState = {
  /** hashed finding key -> ISO time it last alerted (hashed: the state branch is public) */
  alerted: Record<string, string>;
};

const RUNBOOK_URL = "https://github.com/josephcescobar/better-ledger-verifier/blob/main/RUNBOOK.md";

const id = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);

export type AlertPlan = { send: Finding[]; resolved: string[]; state: AlertState };

export function planAlerts(findings: Finding[], prev: AlertState, now: Date, repeatHours: number): AlertPlan {
  const alerting = findings.filter((f) => f.severity !== "info");
  const alerted: Record<string, string> = {};
  const send: Finding[] = [];
  for (const f of alerting) {
    const k = id(f.key);
    const last = prev.alerted[k];
    const due =
      !last || (f.severity === "critical" && now.getTime() - Date.parse(last) >= repeatHours * 3_600_000);
    if (due) send.push(f);
    alerted[k] = due ? now.toISOString() : last;
  }
  const current = new Set(alerting.map((f) => id(f.key)));
  const resolved = Object.keys(prev.alerted).filter((k) => !current.has(k));
  return { send, resolved, state: { alerted } };
}

function render(plan: AlertPlan, runUrl?: string): { subject: string; text: string } {
  const crit = plan.send.filter((f) => f.severity === "critical").length;
  const subject = plan.send.length
    ? `[BTR ledger] ${crit ? `${crit} CRITICAL` : `${plan.send.length} warning(s)`}`
    : "[BTR ledger] resolved";
  const lines = plan.send.map((f) => `${f.severity.toUpperCase()} [${f.check}] ${f.message}`);
  if (plan.resolved.length) lines.push(`Resolved since the last run: ${plan.resolved.length} finding(s).`);
  if (runUrl) lines.push(`Run: ${runUrl}`);
  lines.push(`What to do: ${RUNBOOK_URL}`);
  return { subject, text: lines.join("\n") };
}

export async function deliver(plan: AlertPlan, env: NodeJS.ProcessEnv): Promise<string[]> {
  // "Resolved" goes out only once everything is clear, so it can't be
  // mistaken for an all-clear while other problems are still open.
  if (!plan.send.length && (!plan.resolved.length || Object.keys(plan.state.alerted).length)) return [];
  const { subject, text } = render(plan, env.RUN_URL);
  const errors: string[] = [];
  const attempt = async (name: string, fn: () => Promise<Response>) => {
    try {
      const res = await fn();
      if (!res.ok) errors.push(`${name}: HTTP ${res.status}`);
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  };
  const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  if (env.RESEND_API_KEY && env.ALERT_EMAIL_FROM && env.ALERT_EMAIL_TO) {
    await attempt("email", () =>
      json(
        "https://api.resend.com/emails",
        { from: env.ALERT_EMAIL_FROM, to: env.ALERT_EMAIL_TO!.split(",").map((s) => s.trim()), subject, text },
        { authorization: `Bearer ${env.RESEND_API_KEY}` },
      ),
    );
  }
  if (env.ALERT_WEBHOOK_URL) {
    // Slack reads `text`, Discord reads `content`; each ignores the other.
    const body = `${subject}\n${text}`.slice(0, 1900);
    await attempt("webhook", () => json(env.ALERT_WEBHOOK_URL!, { text: body, content: body }));
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    await attempt("telegram", () =>
      json(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: env.TELEGRAM_CHAT_ID,
        text: `${subject}\n${text}`.slice(0, 4000),
      }),
    );
  }
  return errors;
}
