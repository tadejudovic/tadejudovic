/** Keeps the last few hundred log lines in memory so the creator can copy them from the app (Settings → diagnostics). */
const MAX = 400;
const lines: string[] = [];

for (const level of ["log", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    lines.push(`${new Date().toISOString().slice(11, 19)} ${level === "log" ? "" : level.toUpperCase() + " "}${text}`.slice(0, 2000));
    if (lines.length > MAX) lines.splice(0, lines.length - MAX);
    original(...args);
  };
}

export const recentLogs = (n = 150) => lines.slice(-n);
