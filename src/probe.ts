import { execFile } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { formatDistanceStrict } from 'date-fns'
import { formatDate, log } from './log.js'
import { notify } from './notify.js'
import { checkMinutes, deviceIp, deviceName, failureThreshold, reminderMinutes } from './config.js'

/**
 * Device probe. The monitored device is on the local network and sits behind an RCD. When it stops
 * answering pings it has lost power, and because of the RCD it will stay off until someone
 * resets it, so we alert, remind every `reminderMinutes` while it stays down, and
 * notify once it is back. For an intentional shutdown, alerts can be paused for a set time:
 * checks keep running so status stays current, and once the pause ends (or is lifted with
 * resume) alerting picks up from the current state, so an outage that is still ongoing is
 * reported right away. State is persisted to a JSON file so restarts keep the outage start
 * time, reminder cadence and pause.
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
  pausedUntil: Date | null
}

const STATE_FILE = 'state.json'
const PING_TIMEOUT_MS = 10000
const DATE_FIELDS: (keyof State)[] = [
  'lastChecked',
  'lastSeen',
  'failingSince',
  'downSince',
  'lastNotifiedAt',
  'pausedUntil',
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
  pausedUntil: null,
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
      `State restored: ${state.status}` +
        (state.downSince ? `, down since ${formatDate(state.downSince)}` : '') +
        (state.pausedUntil ? `, paused until ${formatDate(state.pausedUntil)}` : ''),
    )
  } catch (error: any) {
    log('Could not read state, starting fresh:', error.message)
  }
}

const saveState = () => {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch (error: any) {
    log('Could not persist state:', error.message)
  }
}

const ping = () =>
  new Promise<void>((resolve, reject) => {
    execFile('ping', ['-c', '1', deviceIp!], { timeout: PING_TIMEOUT_MS }, (error, _out, err) => {
      if (error) reject(new Error(err?.trim() || error.message))
      else resolve()
    })
  })

const downFor = (now: Date) => (state.downSince ? formatDistanceStrict(now, state.downSince) : '')

const isPaused = (now: Date) => !!state.pausedUntil && now < state.pausedUntil

const statusLine = () =>
  state.status === 'down'
    ? `${deviceName} is currently OFFLINE (down for ${downFor(new Date())}).`
    : `${deviceName} is currently ${state.status === 'up' ? 'online' : 'not checked yet'}.`

/** Lifts the pause. Alerts for an ongoing outage go out on the next failed check. */
const endPause = async (reason: string) => {
  state.pausedUntil = null
  state.lastNotifiedAt = null
  saveState()

  log(`${reason}, alerts resumed`)
  await notify({
    title: `${deviceName} monitoring resumed`,
    message: [`${reason}.`, statusLine()].join('\n'),
    priority: 'low',
    tags: ['arrow_forward'],
  })
}

const sendAlert = async (now: Date, n: Parameters<typeof notify>[0]) => {
  if (isPaused(now)) {
    log(`Alert suppressed (paused until ${formatDate(state.pausedUntil!)}): ${n.title}`)
    return
  }

  state.lastNotifiedAt = now
  saveState()
  await notify(n)
}

const handleSuccess = async (now: Date) => {
  const previous = state.status
  const downSince = state.downSince

  state.status = 'up'
  state.consecutiveFailures = 0
  state.lastSeen = now
  state.failingSince = null
  state.downSince = null
  state.lastError = null

  if (previous === 'down' && downSince) {
    const outage = formatDistanceStrict(now, downSince)

    log(`${deviceName} is back online after ${outage}`)
    await sendAlert(now, {
      title: `${deviceName} is back online`,
      message: [
        `${deviceName} (${deviceIp}) is responding to pings again.`,
        `Offline since ${formatDate(downSince)}, back at ${formatDate(now)} (${outage}).`,
      ].join('\n'),
      priority: 'default',
      tags: ['white_check_mark'],
    })
  } else if (previous === 'unknown') {
    log(`${deviceName} is online (${deviceIp})`)
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
    if (!reminderDue || isPaused(now)) return

    log(`${deviceName} still OFFLINE, down for ${downFor(now)}`)
    await sendAlert(now, {
      title: `${deviceName} still OFFLINE (${downFor(now)})`,
      message: [
        `${deviceName} (${deviceIp}) has been down for ${downFor(now)}.`,
        `Offline since ${formatDate(state.downSince!)}, ${state.consecutiveFailures} failed checks.`,
        'Reset the RCD to restore power, or pause alerts if this is intentional.',
      ].join('\n'),
      priority: 'high',
      tags: ['warning', 'electric_plug'],
    })
    return
  }

  if (state.consecutiveFailures < failureThreshold) {
    log(
      `${deviceName} check failed (${state.consecutiveFailures}/${failureThreshold}):`,
      state.lastError,
    )
    saveState()
    return
  }

  state.status = 'down'
  state.downSince = state.failingSince
  saveState()

  log(`${deviceName} is OFFLINE since ${formatDate(state.downSince!)}:`, state.lastError)
  await sendAlert(now, {
    title: `${deviceName} is OFFLINE`,
    message: [
      `${deviceName} (${deviceIp}) stopped responding to pings.`,
      `Failing since ${formatDate(state.downSince!)}, ${state.consecutiveFailures} checks in a row.`,
      state.lastSeen
        ? `Last seen ${formatDate(state.lastSeen)}.`
        : 'Never seen online since start.',
      'The RCD has probably tripped, so it will stay off until reset.',
      `Reminders every ${reminderMinutes} min until it is back.`,
      `Error: ${state.lastError}`,
    ].join('\n'),
    priority: 'high',
    tags: ['warning', 'electric_plug'],
  })
}

export const checkDevice = async () => {
  if (inFlight) return
  inFlight = true
  const now = new Date()
  state.lastChecked = now

  try {
    if (state.pausedUntil && !isPaused(now)) await endPause('Pause ended')

    await ping()
    await handleSuccess(now)
  } catch (error) {
    await handleFailure(now, error)
  } finally {
    inFlight = false
  }
}

export const startProbe = () => {
  if (!deviceIp) {
    log('Probe disabled (deviceIp not set)')
    return
  }

  loadState()
  log(
    `Probe started, pinging ${deviceIp} every ${checkMinutes} min,`,
    `alert after ${failureThreshold} failures, remind every ${reminderMinutes} min`,
  )

  void checkDevice()
  timer = setInterval(checkDevice, checkMinutes * 60 * 1000)
}

export const stopProbe = () => {
  if (timer) clearInterval(timer)
  timer = null
}

/** Pauses alerts for `ms` milliseconds. Checks keep running so status stays current. */
export const pause = async (ms: number) => {
  state.pausedUntil = new Date(Date.now() + ms)
  saveState()

  const until = formatDate(state.pausedUntil)
  log(`Alerts paused until ${until}`)
  await notify({
    title: `${deviceName} monitoring paused`,
    message: [`No alerts until ${until}.`, statusLine()].join('\n'),
    priority: 'low',
    tags: ['pause_button'],
  })

  return getStatus()
}

/** Lifts a pause early and checks right away. */
export const resume = async () => {
  if (state.pausedUntil) {
    await endPause('Resumed manually')
    await checkDevice()
  }

  return getStatus()
}

export const getStatus = () => {
  if (!deviceIp) return null

  const now = new Date()
  return {
    name: deviceName,
    ip: deviceIp,
    status: state.status,
    consecutiveFailures: state.consecutiveFailures,
    lastChecked: state.lastChecked,
    lastSeen: state.lastSeen,
    downSince: state.downSince,
    downFor: state.status === 'down' ? downFor(now) : null,
    lastError: state.lastError,
    lastNotifiedAt: state.lastNotifiedAt,
    pausedUntil: isPaused(now) ? state.pausedUntil : null,
  }
}
