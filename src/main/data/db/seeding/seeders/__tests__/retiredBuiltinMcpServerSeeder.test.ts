import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { agentTable } from '@data/db/schemas/agent'
import { assistantTable } from '@data/db/schemas/assistant'
import { agentMcpServerTable, assistantMcpServerTable } from '@data/db/schemas/assistantRelations'
import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { RetiredBuiltinMcpServerSeeder } from '@data/db/seeding/seeders/retiredBuiltinMcpServerSeeder'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/data/types/assistant'

describe('RetiredBuiltinMcpServerSeeder', () => {
  const dbh = setupTestDatabase()

  const insert = (values: Partial<typeof mcpServerTable.$inferInsert> & { name: string }) =>
    dbh.db.insert(mcpServerTable).values(values)

  const rowFor = async (name: string) => {
    const [row] = await dbh.db.select().from(mcpServerTable).where(eq(mcpServerTable.name, name))
    return row
  }

  it('turns a hosted built-in into a user-owned server and keeps its endpoint', async () => {
    await insert({
      name: '@cherry/flomo',
      type: 'streamableHttp',
      baseUrl: 'https://flomoapp.com/mcp',
      headers: { APP: 'Cherry Studio' },
      installSource: 'builtin'
    })

    new RetiredBuiltinMcpServerSeeder().run(dbh.db)

    const row = await rowFor('@cherry/flomo')
    expect(row.installSource).toBe('manual')
    expect(row.baseUrl).toBe('https://flomoapp.com/mcp')
    expect(row.headers).toEqual({ APP: 'Cherry Studio' })
  })

  it('moves the QVeris API key into the header that carries it', async () => {
    await insert({
      name: '@cherry/qveris',
      type: 'streamableHttp',
      baseUrl: 'https://mcp.qveris.ai/mcp',
      env: { QVERIS_API_KEY: 'secret' },
      installSource: 'builtin'
    })

    new RetiredBuiltinMcpServerSeeder().run(dbh.db)

    const row = await rowFor('@cherry/qveris')
    expect(row.installSource).toBe('manual')
    expect(row.headers).toEqual({ Authorization: 'Bearer secret' })
    expect(row.env).toEqual({})
  })

  it('keeps a header the user set by hand', async () => {
    await insert({
      name: '@cherry/qveris',
      type: 'streamableHttp',
      baseUrl: 'https://mcp.qveris.ai/mcp',
      env: { QVERIS_API_KEY: 'secret' },
      headers: { Authorization: 'Bearer mine' },
      installSource: 'builtin'
    })

    new RetiredBuiltinMcpServerSeeder().run(dbh.db)

    const row = await rowFor('@cherry/qveris')
    expect(row.headers).toEqual({ Authorization: 'Bearer mine' })
    expect(row.env).toEqual({ QVERIS_API_KEY: 'secret' })
  })

  it('adopts the hosted endpoint for a row still on the retired in-process transport', async () => {
    await insert({ name: '@cherry/flomo', type: 'inMemory', installSource: 'builtin' })

    new RetiredBuiltinMcpServerSeeder().run(dbh.db)

    const row = await rowFor('@cherry/flomo')
    expect(row.installSource).toBe('manual')
    expect(row.type).toBe('streamableHttp')
    expect(row.baseUrl).toBe('https://flomoapp.com/mcp')
    expect(row.headers).toEqual({ APP: 'Cherry Studio' })
  })

  it('keeps the endpoint a hosted row already uses', async () => {
    await insert({
      name: '@cherry/nowledge-mem',
      type: 'streamableHttp',
      baseUrl: 'http://192.168.1.2:14242/mcp',
      headers: { Authorization: 'Bearer mine' },
      installSource: 'builtin'
    })

    new RetiredBuiltinMcpServerSeeder().run(dbh.db)

    const row = await rowFor('@cherry/nowledge-mem')
    expect(row.type).toBe('streamableHttp')
    expect(row.baseUrl).toBe('http://192.168.1.2:14242/mcp')
    expect(row.headers).toEqual({ Authorization: 'Bearer mine' })
  })

  it('removes an in-process built-in whose implementation is gone', async () => {
    await insert({
      name: '@cherry/didi-mcp',
      type: 'inMemory',
      env: { DIDI_API_KEY: 'secret' },
      installSource: 'builtin'
    })

    new RetiredBuiltinMcpServerSeeder().run(dbh.db)

    expect(await rowFor('@cherry/didi-mcp')).toBeUndefined()
  })

  it('unbinds a removed in-process built-in from the agents and assistants that used it', async () => {
    const [row] = await insert({
      name: '@cherry/brave-search',
      type: 'inMemory',
      installSource: 'builtin'
    }).returning()
    dbh.db
      .insert(agentTable)
      .values({ id: 'agent-1', type: 'pi', name: 'Agent', instructions: '', orderKey: 'a0' })
      .run()
    dbh.db
      .insert(assistantTable)
      .values({ id: 'assistant-1', name: 'Assistant', emoji: '', orderKey: 'a0', settings: DEFAULT_ASSISTANT_SETTINGS })
      .run()
    dbh.db.insert(agentMcpServerTable).values({ agentId: 'agent-1', mcpServerId: row.id }).run()
    dbh.db.insert(assistantMcpServerTable).values({ assistantId: 'assistant-1', mcpServerId: row.id }).run()

    new RetiredBuiltinMcpServerSeeder().run(dbh.db)

    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([])
    expect(dbh.db.select().from(assistantMcpServerTable).all()).toEqual([])
  })

  it('leaves a server the user owns alone even when its name collides with a retired built-in', async () => {
    await insert({ name: '@cherry/didi-mcp', type: 'stdio', command: 'npx', installSource: 'manual' })

    new RetiredBuiltinMcpServerSeeder().run(dbh.db)

    const row = await rowFor('@cherry/didi-mcp')
    expect(row.installSource).toBe('manual')
    expect(row.command).toBe('npx')
  })

  it('leaves the built-ins that stay in the catalog alone', async () => {
    await insert({ name: '@cherry/memory', type: 'inMemory', installSource: 'builtin' })

    new RetiredBuiltinMcpServerSeeder().run(dbh.db)

    const row = await rowFor('@cherry/memory')
    expect(row.installSource).toBe('builtin')
    expect(row.type).toBe('inMemory')
  })

  it('never installs a retired built-in the user does not have', async () => {
    new RetiredBuiltinMcpServerSeeder().run(dbh.db)

    expect(await dbh.db.select().from(mcpServerTable)).toEqual([])
  })
})
