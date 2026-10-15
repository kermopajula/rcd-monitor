import 'dotenv/config'

const str = (name: string): string | undefined => process.env[name] || undefined
const num = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return process.env[name] && Number.isFinite(value) ? value : fallback
}

export const deviceIp = str('deviceIp')
export const deviceName = str('deviceName') || 'Device'
export const checkMinutes = num('checkMinutes', 5)
export const failureThreshold = num('failureThreshold', 2)
export const reminderMinutes = num('reminderMinutes', 60)

export const port = num('port', 3001)
export const apiToken = str('apiToken')

export const ntfyUrl = str('ntfyUrl') || 'https://ntfy.sh'
export const ntfyTopic = str('ntfyTopic')
export const ntfyToken = str('ntfyToken')
export const resendApiKey = str('resendApiKey')
export const notifyEmailFrom = str('notifyEmailFrom')
export const notifyEmailTo = str('notifyEmailTo')
