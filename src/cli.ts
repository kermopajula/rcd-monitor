import { apiToken, port } from './config.js'

/**
 * Talks to the running monitor's HTTP API on this machine, reading port and apiToken from .env:
 *   pnpm status          current state
 *   pnpm pause 8h        pause alerts for 30m / 8h / 2d
 *   pnpm resume          lift a pause early
 */

const COMMANDS: Record<string, (arg?: string) => [method: string, path: string]> = {
  status: () => ['GET', '/status'],
  pause: (arg) => ['POST', `/pause?for=${encodeURIComponent(arg || '')}`],
  resume: () => ['POST', '/resume'],
}

const [command, arg] = process.argv.slice(2)
const route = COMMANDS[command]

if (!route) {
  console.error('Usage: pnpm status | pnpm pause <30m|8h|2d> | pnpm resume')
  process.exit(1)
}

const [method, path] = route(arg)

try {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
  })
  console.log(await res.text())
  if (!res.ok) process.exit(1)
} catch (error: any) {
  console.error(
    `Could not reach the monitor on port ${port}:`,
    error.cause?.message || error.message,
  )
  process.exit(1)
}
