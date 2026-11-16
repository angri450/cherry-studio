import { describe, expect, it } from 'vitest'

import { PRESET_MCP_SERVERS } from '@shared/data/presets/mcpServers'
import { BuiltinMcpServerNames } from '@shared/utils/mcp'

const preset = (name: string) => PRESET_MCP_SERVERS.find((server) => server.name === name)

describe('PRESET_MCP_SERVERS', () => {
  it('ships the filesystem server with no platform-shaped baseDir default', () => {
    expect(preset(BuiltinMcpServerNames.filesystem)?.args ?? []).toEqual([])
  })

  it('models the online-package server as stdio instead of in-memory', () => {
    expect(preset(BuiltinMcpServerNames.mcpAutoInstall)).toEqual(
      expect.objectContaining({ type: 'stdio', command: 'npx' })
    )
  })

  it('ships no third-party credential built-ins', () => {
    // A built-in that needs a vendor account makes the marketplace entry depend on a
    // credential Cherry cannot ship, so only vendor-neutral servers remain.
    for (const server of PRESET_MCP_SERVERS) {
      expect(server.provider, server.name).not.toMatch(/flomo|qveris|dify|didi|brave|nowledge/i)
    }
  })

  it('gives every non in-memory preset what it needs to connect', () => {
    // The seeder copies these fields onto installed rows, so a preset missing them
    // would migrate a working server into an unconnectable one.
    for (const server of PRESET_MCP_SERVERS) {
      if (server.type === 'inMemory') continue
      if (server.type === 'stdio') {
        expect(server.command, server.name).toBeTruthy()
      } else {
        expect(server.baseUrl, server.name).toBeTruthy()
      }
    }
  })
})
