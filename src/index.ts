import { createServer, IncomingMessage, ServerResponse } from 'http'
import { log } from './log.js'
import { apiToken, port } from './config.js'
import { notify } from './notify.js'
import { getPoolHeaterStatus, startPoolHeaterProbe } from './poolHeater.js'

/**
 * Tiny HTTP API (no framework):
 *   GET  /status        current probe state
 *   POST /test          send a test notification through every configured channel
 * All requests need "Authorization: Bearer <apiToken>" when apiToken is set.
 */

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
