// Turning "on 3 November", "last Tuesday", "on Monday" into concrete day windows in the
// user's timezone, so memory can be looked up by date without asking the model.
import * as chrono from "chrono-node";

export function now(): Date {
  const o = process.env.NOW_OVERRIDE;
  return o ? new Date(o) : new Date();
}

export type Window = { start: Date; end: Date; label: string; text: string };

const DAY = 86_400_000;

// Midnight at the start of `d`'s local day, for a timezone given as minutes east of UTC.
export function startOfLocalDay(d: Date, tzOffsetMin: number): Date {
  const local = d.getTime() + tzOffsetMin * 60_000;
  return new Date(local - (((local % DAY) + DAY) % DAY) - tzOffsetMin * 60_000);
}

export function localDateLabel(d: Date, tzOffsetMin: number): string {
  const local = new Date(d.getTime() + tzOffsetMin * 60_000);
  return local.toISOString().slice(0, 10) + " (" +
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][local.getUTCDay()] + ")";
}

function dayWindow(d: Date, tz: number, text: string): Window {
  const start = startOfLocalDay(d, tz);
  return { start, end: new Date(start.getTime() + DAY), label: localDateLabel(start, tz), text };
}

/**
 * Past-time references in a message, as day windows. Only the past: a user asking
 * "what did I ask on Monday" never means next Monday.
 *
 * A bare weekday ("on Tuesday", "last Tuesday") is ambiguous: on Wednesday 11 Nov,
 * "last Tuesday" can mean 10 Nov or 3 Nov. We return both and let the memory lookup
 * keep whichever day actually has a matching conversation.
 */
export function pastWindows(message: string, ref: Date, tz: number): Window[] {
  const out: Window[] = [];
  const results = chrono.parse(message, { instant: ref, timezone: tz }, { forwardDate: false });
  for (const r of results) {
    const text = r.text;
    if (/\blast week\b/i.test(text)) {
      const thisMonday = startOfLocalDay(ref, tz).getTime() -
        ((new Date(ref.getTime() + tz * 60_000).getUTCDay() + 6) % 7) * DAY;
      out.push({ start: new Date(thisMonday - 7 * DAY), end: new Date(thisMonday),
                 label: "last week (" + localDateLabel(new Date(thisMonday - 7 * DAY), tz) + " to Sun)", text });
      continue;
    }
    let d = r.start.date();
    if (d.getTime() > ref.getTime()) d = new Date(d.getTime() - 7 * DAY); // never the future
    if (r.start.isCertain("weekday") && !r.start.isCertain("day")) {
      out.push(dayWindow(d, tz, text));
      out.push(dayWindow(new Date(d.getTime() - 7 * DAY), tz, text));
      continue;
    }
    out.push(dayWindow(d, tz, text));
  }
  return out;
}
