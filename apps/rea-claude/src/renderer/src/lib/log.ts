/** Connect-log shaping and elapsed formatting [renderer §4.19]. */

const HTTPX_NOISE = /INFO \[httpx\] HTTP Request:/;
const BOOTING = /^\s*Lab is booting\.\.\./;
const TIMESTAMP = /^\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+/;

/** Collapse key for a line, or null when the line is kept verbatim. */
function collapseKey(line: string): string | null {
  if (BOOTING.test(line)) return "\u0000booting";
  const stripped = line.replace(TIMESTAMP, "");
  return stripped === line ? null : stripped;
}

/**
 * Make the raw log readable: drop httpx request noise; a timestamped line
 * whose message repeats replaces the earlier occurrence in place; all
 * "Lab is booting..." lines collapse into one (latest text, first position).
 */
export function shapeLog(raw: string): string {
  const out: string[] = [];
  const slot = new Map<string, number>();
  for (const line of raw.split("\n")) {
    if (HTTPX_NOISE.test(line)) continue;
    const key = collapseKey(line);
    if (key === null) {
      out.push(line);
      continue;
    }
    const at = slot.get(key);
    if (at === undefined) {
      slot.set(key, out.length);
      out.push(line);
    } else {
      out[at] = line;
    }
  }
  return out.join("\n");
}

/** m:ss, clamped at zero. */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
