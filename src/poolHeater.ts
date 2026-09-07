import { execFile } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { addHours, formatDistanceStrict, isAfter } from 'date-fns'
import { formatDate, log } from './log.js'
import { notify } from './notify.js'
import { checkMinutes, failureThreshold, heaterIp, reminderMinutes } from './config.js'

/**
 * Pool heater probe. The heater is on the local network and sits behind an RCD. When it stops
 * answering pings it has lost power, and because of the RCD it will stay off until someone
 * resets it, so we alert, remind every `reminderMinutes` while it stays down, and
 * notify once it is back. Alerts can be muted (optionally for a number of hours) when the
 * heater is powered off on purpose. State is persisted to a JSON file so restarts keep the
 * outage start time, reminder cadence and mute setting.
 */

type Status = 'unknown' | 'up' | 'down'

interface State {
  status: Status
  consecutiveFailures: number
  lastChecked: Date | null
  lastSeen: Date | null
  failingSince: Date | null
  downSince: Date | null
  lastError: string | null
  lastNotifiedAt: Date | null
  muted: boolean
  mutedAt: Date | null
  mutedUntil: Date | null
}

const STATE_FILE = 'state.json'
const PING_TIMEOUT_MS = 10000
const DATE_FIELDS: (keyof State)[] = [
  'lastChecked',
  'lastSeen',
  'failingSince',
  'downSince',
  'lastNotifiedAt',
  'mutedAt',
  'mutedUntil',
]

const initialState = (): State => ({
  status: 'unknown',
  consecutiveFailures: 0,
  lastChecked: null,
  lastSeen: null,
  failingSince: null,
  downSince: null,
  lastError: null,
  lastNotifiedAt: null,
  muted: false,
  mutedAt: null,
  mutedUntil: null,
})

let state: State = initialState()
let timer: NodeJS.Timeout | null = null
let inFlight = false

const loadState = () => {
  if (!existsSync(STATE_FILE)) return

  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    const loaded: State = { ...initialState(), ...raw }
    for (const field of DATE_FIELDS) {
      const value = raw[field]
      ;(loaded as any)[field] = value ? new Date(value) : null
    }
    state = loaded
    log(
      `Pool heater state restored: ${state.status}` +
        (state.downSince ? `, down since ${formatDate(state.downSince)}` : '') +
        (state.muted ? ', alerts muted' : ''),
    )
  } catch (error: any) {
    log('Could not read pool heater state, starting fresh:', error.message)
  }
}

const saveState = () => {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch (error: any) {
    log('Could not persist pool heater state:', error.message)
  }
}

const ping = () =>
  new Promise<void>((resolve, reject) => {
    execFile('ping', ['-c', '1', heaterIp!], { timeout: PING_TIMEOUT_MS }, (error, _out, err) => {
      if (error) reject(new Error(err?.trim() || error.message))
      else resolve()
    })
  })

const downFor = (now: Date) => (state.downSince ? formatDistanceStrict(now, state.downSince) : '')

/** Clears an expired timed mute. Returns whether alerts are currently muted. */
const isMuted = (now: Date) => {
  if (state.muted && state.mutedUntil && isAfter(now, state.mutedUntil)) {
    log('Pool heater mute expired, alerts re-enabled')
    state.muted = false
    state.mutedAt = null
    state.mutedUntil = null
    saveState()
  }

  return state.muted
}

const sendAlert = async (now: Date, n: Parameters<typeof notify>[0]) => {
  if (isMuted(now)) {
    log(`Pool heater alert suppressed (muted): ${n.title}`)
    return
  }

  state.lastNotifiedAt = now
  saveState()
  await notify(n)
}

const handleSuccess = async (now: Date) => {
  const previous = state.status
  const downSince = state.downSince
  const wasMuted = state.muted

  state.status = 'up'
  state.consecutiveFailures = 0
  state.lastSeen = now
  state.failingSince = null
  state.downSince = null
  state.lastError = null

  if (previous === 'down' && downSince) {
    const outage = formatDistanceStrict(now, downSince)

    // A muted outage was intentional; it is over now, so alerts go back on automatically.
    if (wasMuted) {
      state.muted = false
      state.mutedAt = null
      state.mutedUntil = null
      log('Pool heater is back, mute lifted automatically')
    }

    log(`Pool heater is back online after ${outage}`)
    await notify({
      title: 'Pool heater is back online',
      message: [
        `The pool heater (${heaterIp}) is responding to pings again.`,
        `Offline since ${formatDate(downSince)}, back at ${formatDate(now)} (${outage}).`,
        wasMuted ? 'Alerts were muted and are now re-enabled.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
      priority: 'default',
      tags: ['white_check_mark'],
    })
    state.lastNotifiedAt = now
  } else if (previous === 'unknown') {
    log(`Pool heater is online (${heaterIp})`)
  }

  saveState()
}

const handleFailure = async (now: Date, error: any) => {
  state.consecutiveFailures += 1
  state.failingSince = state.failingSince || now
  state.lastError = error?.message || String(error)

  if (state.status === 'down') {
    const reminderDue =
      !state.lastNotifiedAt ||
      now.getTime() - state.lastNotifiedAt.getTime() >= reminderMinutes * 60 * 1000

    saveState()
    if (!reminderDue) return

    log(`Pool heater still OFFLINE, down for ${downFor(now)}`)
    await sendAlert(now, {
      title: `Pool heater still OFFLINE (${downFor(now)})`,
      message: [
        `The pool heater (${heaterIp}) has been down for ${downFor(now)}.`,
        `Offline since ${formatDate(state.downSince!)}, ${state.consecutiveFailures} failed checks.`,
        'Reset the RCD to restore power, or mute alerts if this is intentional.',
      ].join('\n'),
      priority: 'high',
      tags: ['warning', 'electric_plug'],
    })
    return
  }

  if (state.consecutiveFailures < failureThreshold) {
    log(
      `Pool heater check failed (${state.consecutiveFailures}/${failureThreshold}):`,
      state.lastError,
    )
    saveState()
    return
  }

  state.status = 'down'
  state.downSince = state.failingSince
  saveState()

  log(`Pool heater is OFFLINE since ${formatDate(state.downSince!)}:`, state.lastError)
  await sendAlert(now, {
    title: 'Pool heater is OFFLINE',
    message: [
      `The pool heater (${heaterIp}) stopped responding to pings.`,
      `Failing since ${formatDate(state.downSince!)}, ${state.consecutiveFailures} checks in a row.`,
      state.lastSeen
        ? `Last seen ${formatDate(state.lastSeen)}.`
        : 'Never seen online since start.',
      'The RCD has probably tripped, so it will stay off until reset.',
      `Reminders every ${reminderMinutes} min until it is back or alerts are muted.`,
      `Error: ${state.lastError}`,
    ].join('\n'),
    priority: 'high',
    tags: ['warning', 'electric_plug'],
  })
}

export const checkPoolHeater = async () => {
  if (inFlight) return
  inFlight = true
  const now = new Date()
  state.lastChecked = now

  try {
    await ping()
    await handleSuccess(now)
  } catch (error) {
    await handleFailure(now, error)
  } finally {
    inFlight = false
  }
}

export const startPoolHeaterProbe = () => {
  if (!heaterIp) {
    log('Pool heater probe disabled (heaterIp not set)')
    return
  }

  loadState()
  log(
    `Pool heater probe started, pinging ${heaterIp} every ${checkMinutes} min,`,
    `alert after ${failureThreshold} failures, remind every ${reminderMinutes} min`,
  )

  void checkPoolHeater()
  timer = setInterval(checkPoolHeater, checkMinutes * 60 * 1000)
}

export const stopPoolHeaterProbe = () => {
  if (timer) clearInterval(timer)
  timer = null
}

/** Mutes alerts, indefinitely or for `hours`. Checks keep running so status stays current. */
export const mutePoolHeaterAlerts = (hours?: number) => {
  const now = new Date()
  state.muted = true
  state.mutedAt = now
  state.mutedUntil = hours && hours > 0 ? addHours(now, hours) : null
  saveState()
  log(
    `Pool heater alerts muted` +
      (state.mutedUntil ? ` until ${formatDate(state.mutedUntil)}` : ' until unmuted'),
  )

  return getPoolHeaterStatus()
}

/** Re-enables alerts. If the heater is currently down, an alert goes out on the next check. */
export const unmutePoolHeaterAlerts = () => {
  state.muted = false
  state.mutedAt = null
  state.mutedUntil = null
  state.lastNotifiedAt = null
  saveState()
  log('Pool heater alerts unmuted')
  void checkPoolHeater()

  return getPoolHeaterStatus()
}

export const getPoolHeaterStatus = () => {
  if (!heaterIp) return null

  const now = new Date()
  return {
    ip: heaterIp,
    status: state.status,
    consecutiveFailures: state.consecutiveFailures,
    lastChecked: state.lastChecked,
    lastSeen: state.lastSeen,
    downSince: state.downSince,
    downFor: state.status === 'down' ? downFor(now) : null,
    lastError: state.lastError,
    lastNotifiedAt: state.lastNotifiedAt,
    muted: isMuted(now),
    mutedAt: state.mutedAt,
    mutedUntil: state.mutedUntil,
  }
}
