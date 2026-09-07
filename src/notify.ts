import { log } from './log.js'
import {
  ntfyUrl,
  ntfyTopic,
  ntfyToken,
  resendApiKey,
  notifyEmailFrom,
  notifyEmailTo,
} from './config.js'

export type Priority = 'low' | 'default' | 'high' | 'urgent'

export interface Notification {
  title: string
  message: string
  priority?: Priority
  /** ntfy tags, e.g. emoji shortcodes like 'warning' or 'white_check_mark' */
  tags?: string[]
}

export interface NotifyResult {
  ntfy: boolean
  email: boolean
}

const NTFY_PRIORITY: Record<Priority, number> = { low: 2, default: 3, high: 4, urgent: 5 }
const TIMEOUT_MS = 10000

export const isNtfyConfigured = () => !!ntfyTopic
export const isEmailConfigured = () => !!(resendApiKey && notifyEmailFrom && notifyEmailTo)

const post = async (url: string, body: string, headers: Record<string, string>) => {
  const response = await fetch(url, {
    method: 'POST',
    body,
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`)
}

const sendNtfy = (n: Notification) => {
  const headers: Record<string, string> = {
    Title: n.title,
    Priority: String(NTFY_PRIORITY[n.priority || 'default']),
    'Content-Type': 'text/plain; charset=utf-8',
  }
  if (n.tags?.length) headers.Tags = n.tags.join(',')
  if (ntfyToken) headers.Authorization = `Bearer ${ntfyToken}`

  return post(`${ntfyUrl.replace(/\/+$/, '')}/${ntfyTopic}`, n.message, headers)
}

const sendEmail = (n: Notification) =>
  post(
    'https://api.resend.com/emails',
    JSON.stringify({
      from: notifyEmailFrom,
      to: notifyEmailTo!.split(',').map((address) => address.trim()),
      subject: n.title,
      text: n.message,
    }),
    { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
  )

/** Sends through every configured channel. Never throws; failures are logged. */
export const notify = async (n: Notification): Promise<NotifyResult> => {
  const result: NotifyResult = { ntfy: false, email: false }

  if (!isNtfyConfigured() && !isEmailConfigured()) {
    log('Notification skipped, no channel configured (ntfyTopic or resendApiKey):', n.title)
    return result
  }

  await Promise.all([
    isNtfyConfigured() &&
      sendNtfy(n)
        .then(() => (result.ntfy = true))
        .catch((error) => log('ntfy failed:', error.message)),
    isEmailConfigured() &&
      sendEmail(n)
        .then(() => (result.email = true))
        .catch((error) => log('Resend failed:', error.message)),
  ])

  log('Notification sent:', n.title, result)
  return result
}
