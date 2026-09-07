import { createServer, IncomingMessage, ServerResponse } from 'http'
import { log } from './log.js'
import { apiToken, port } from './config.js'
import { notify } from './notify.js'
import {
  getPoolHeaterStatus,
  mutePoolHeaterAlerts,
  startPoolHeaterProbe,
  unmutePoolHeaterAlerts,
} from './poolHeater.js'

/**
 * Tiny HTTP API (no framework):
 *   GET  /status        current probe state
 *   POST /mute          body {"hours": 8} or ?hours=8, omit for indefinite
 *   POST /unmute        re-enable alerts (checks immediately)
 *   POST /test          send a test notification through every configured channel
 * All requests need "Authorization: Bearer <apiToken>" when apiToken is set.
 */

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => resolve(body))
  })

const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data, null, 2))
}

const isAuthorized = (req: IncomingMessage) => {
  if (!apiToken) return true
  const header = req.headers.authorization || ''
  return header === `Bearer ${apiToken}`
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')

  if (!isAuthorized(req)) return json(res, 401, { error: 'Unauthorized' })

  try {
    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, getPoolHeaterStatus())
    }

    if (req.method === 'POST' && url.pathname === '/mute') {
      const body = await readBody(req)
      let hours = Number(url.searchParams.get('hours'))
      if (body) {
        try {
          hours = Number(JSON.parse(body).hours)
        } catch {
          return json(res, 400, { error: 'Body must be JSON like {"hours": 8}' })
        }
      }
      return json(res, 200, mutePoolHeaterAlerts(hours > 0 ? hours : undefined))
    }

    if (req.method === 'POST' && url.pathname === '/unmute') {
      return json(res, 200, unmutePoolHeaterAlerts())
    }

    if (req.method === 'POST' && url.pathname === '/test') {
      const result = await notify({
        title: 'Pool heater monitor test',
        message: `Test notification sent at ${new Date().toISOString()}`,
        tags: ['bell'],
      })
      return json(res, 200, result)
    }

    return json(res, 404, { error: 'Not found' })
  } catch (error: any) {
    log('Request failed:', error.message)
    return json(res, 500, { error: error.message })
  }
})

server.listen(port, () => {
  log(
    `Pool heater monitor listening on port ${port}${apiToken ? '' : ' (no apiToken set, API is open)'}`,
  )
  startPoolHeaterProbe()
})

const shutdown = () => {
  log('Shutting down')
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
