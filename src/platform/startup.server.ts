import { ConfigurationError, readWebConfig } from './config.server'
import type { NitroAppPlugin } from 'nitro/types'
import { getEventContext } from 'nitro/h3'
import { createWebResources } from './runtime.server'

const webConfig = readWebConfig(process.env)

// Nitro statically imports this plugin before its Node preset reads host/port.
// A plugin callback alone is too late for those two settings.
const invalidAliases = [
  'NITRO_HOST', 'NITRO_PORT', 'NITRO_SHUTDOWN_TIMEOUT',
  'SERVER_SHUTDOWN_TIMEOUT', 'NITRO_SSL_CERT', 'NITRO_SSL_KEY',
].filter(key => process.env[key] !== undefined)
for (const key of ['CI', 'TEST']) {
  if (process.env[key]) invalidAliases.push(key)
}
if (invalidAliases.length) throw new ConfigurationError(invalidAliases)

const owner = createWebResources(process.env)
// Nitro 3.0.260903-beta does not await plugin callbacks. Static initialization
// must await the real Layer before the node preset can open its listener.
const resources = await owner.ready()

process.env.NITRO_HOST = webConfig.hostname
process.env.NITRO_PORT = String(webConfig.port)

const configureNodeShutdown: NitroAppPlugin = app => {
  // This callback runs before srvx serve(), whose released plugin uses seconds.
  process.env.SERVER_SHUTDOWN_TIMEOUT = String(webConfig.shutdownTimeoutMs / 1000)
  app.hooks.hook('request', event => { getEventContext(event).appResources = resources })
  app.hooks.hook('close', () => owner.dispose())
}
export default configureNodeShutdown
