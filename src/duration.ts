const UNIT_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }

/** Parses durations like "30m", "8h" or "2d" (a bare number means hours). Returns ms or null. */
export const parseDuration = (input: string | null | undefined) => {
  const match = input?.trim().match(/^(\d+(?:\.\d+)?)\s*([mhd])?$/i)
  if (!match) return null

  const ms = Number(match[1]) * UNIT_MS[(match[2]?.toLowerCase() || 'h') as keyof typeof UNIT_MS]
  return ms > 0 ? ms : null
}
