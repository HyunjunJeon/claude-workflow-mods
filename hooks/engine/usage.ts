// The usage hold: while an account rate-limit window is at or above usage_hold_percent, no run of the session starts a
// new node. register.ts reads the windows from the host ($.session.usage() at session start, then each session.measure)
// and asks here whether they hold.

// usage_hold_percent when the setting is absent or invalid; plugin.json's "default": 90 must match it.
export const DEFAULT_HOLD_PERCENT = 90

// usage_hold_percent from settings: a finite number from 0 to 100, else the default. The host already refuses a value that
// breaks plugin.json's type, min or max before the plugin loads; this keeps the default for a host that does not.
export function parseHoldPercent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : DEFAULT_HOLD_PERCENT
}

// One rate-limit window as the host reports it (claude-code's SessionRateLimit): five_hour, seven_day or a gateway's
// spend_limit, percentUsed 0-100 with one decimal (past 100 on an exceeded spend limit), resetsAt in ISO 8601.
export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

// The window that holds new nodes back. resetsAt is present only when it parses, so a caller can count down to it.
export type UsageHold = { kind: string; percentUsed: number; resetsAt?: string }

// The dag tool's usage_hold field.
export type UsageHoldField = { kind: string; percent_used: number; resets_at?: string }

// Undefined when thresholdPercent is 0 or less (the hold is off) or no window is at or above it. A window whose reset time
// has come is ignored: its reading predates the reset. An unparsable resetsAt counts as no reset time, and the window
// still holds. Of the windows that hold, the fullest wins, the first on a tie.
export function usageHold(rateLimits: readonly RateLimit[], thresholdPercent: number, now: number): UsageHold | undefined {
  if (thresholdPercent <= 0) return undefined
  let held: UsageHold | undefined
  for (const window of rateLimits) {
    if (window.percentUsed < thresholdPercent || (held && window.percentUsed <= held.percentUsed)) continue
    const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt)
    if (resetsAt <= now) continue
    held = { kind: window.kind, percentUsed: window.percentUsed, ...(Number.isNaN(resetsAt) ? {} : { resetsAt: window.resetsAt }) }
  }
  return held
}

// Whole minutes from now until the hold's window resets, rounded up; undefined when its reset time is unknown.
export function resetMinutes(hold: UsageHold, now: number): number | undefined {
  if (hold.resetsAt === undefined) return undefined
  return Math.ceil((Date.parse(hold.resetsAt) - now) / 60_000)
}

// The reason a non-interactive session cancels a held run with: nobody is there to wait for the window.
export function usageLimitReason(hold: UsageHold): string {
  return `usage limit: ${hold.kind} at ${hold.percentUsed}%${hold.resetsAt === undefined ? '' : `, resets at ${hold.resetsAt}`}`
}

export function usageHoldField(hold: UsageHold): UsageHoldField {
  return { kind: hold.kind, percent_used: hold.percentUsed, ...(hold.resetsAt === undefined ? {} : { resets_at: hold.resetsAt }) }
}
