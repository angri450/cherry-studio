import { and, eq, inArray } from 'drizzle-orm'

import { agentMcpServerTable, assistantMcpServerTable } from '@data/db/schemas/assistantRelations'
import { mcpServerTable } from '@data/db/schemas/mcpServer'

import type { DbType, ISeeder } from '../../types'

/**
 * Builtin MCP servers that ship a third-party credential requirement and are no longer
 * offered as built-ins. The names stay here because installed rows keep them.
 */
const RETIRED_BUILTIN_MCP_NAMES = [
  '@cherry/brave-search',
  '@cherry/dify-knowledge',
  '@cherry/didi-mcp',
  '@cherry/flomo',
  '@cherry/qveris',
  '@cherry/nowledge-mem'
] as const

/**
 * The three in-process implementations are gone with the code that hosted them, so an
 * installed row can no longer reach a transport: `hasInMemoryImplementation` rejects the
 * name and `mcpTransportKind` reports the row as invalid. Such a row is removed.
 */
const RETIRED_IN_MEMORY_NAMES = ['@cherry/brave-search', '@cherry/dify-knowledge', '@cherry/didi-mcp'] as const

/**
 * The three hosted servers keep a working transport of their own — a remote HTTP endpoint
 * the user can still reach. Their row survives as a user-owned server instead of a
 * built-in: the endpoint and the credential stay, only the built-in identity goes.
 */
const RETIRED_HOSTED_SERVERS = {
  '@cherry/flomo': { baseUrl: 'https://flomoapp.com/mcp' },
  '@cherry/qveris': { baseUrl: 'https://mcp.qveris.ai/mcp' },
  '@cherry/nowledge-mem': { baseUrl: 'http://127.0.0.1:14242/mcp' }
} as const

/**
 * QVeris turned `QVERIS_API_KEY` into an `Authorization` header at connect time. That
 * translation lived in the code this retirement removes, so the credential moves into the
 * row itself, where the settings page shows it next to the endpoint it authenticates.
 */
function hostedCredential(
  row: { name: string; headers: unknown; env: unknown },
  headers: Record<string, string>
): { headers: Record<string, string>; env: Record<string, string> } {
  const env = (row.env ?? {}) as Record<string, string>
  if (row.name !== '@cherry/qveris') return { headers, env }

  const apiKey = env.QVERIS_API_KEY?.trim()
  if (!apiKey) return { headers, env }
  if (headers.Authorization) return { headers, env }

  const remainingEnv = { ...env }
  delete remainingEnv.QVERIS_API_KEY
  return { headers: { ...headers, Authorization: `Bearer ${apiKey}` }, env: remainingEnv }
}

/**
 * Retire the built-in MCP servers that require a third-party credential.
 *
 * A hosted server keeps working after the built-in disappears, so its row becomes a
 * user-owned server (same endpoint, same credential, `installSource` no longer `builtin`).
 * An in-process server has no transport left at all, so its row and its agent/assistant
 * bindings are removed.
 *
 * Rows the user owns (a server they added themselves under a colliding name) are left
 * alone: only rows that were installed as a built-in are retired.
 */
export class RetiredBuiltinMcpServerSeeder implements ISeeder {
  readonly name = 'retiredBuiltinMcpServer'
  readonly description = 'Retire the built-in MCP servers that require a third-party credential'
  readonly version = '1'

  run(db: DbType): void {
    db.transaction((tx) => {
      const rows = tx
        .select()
        .from(mcpServerTable)
        .where(
          and(inArray(mcpServerTable.name, [...RETIRED_BUILTIN_MCP_NAMES]), eq(mcpServerTable.installSource, 'builtin'))
        )
        .all()

      const inMemoryIds: string[] = []
      for (const row of rows) {
        const hosted = RETIRED_HOSTED_SERVERS[row.name as keyof typeof RETIRED_HOSTED_SERVERS]
        if (hosted) {
          // The endpoint and the credential the user configured stay; only the built-in
          // identity goes, so the settings page keeps showing the server as theirs.
          //
          // A row still on the retired in-process transport adopts the hosted endpoint,
          // because the preset that used to carry it has left the catalog and
          // `BuiltinMcpServerSeeder` no longer covers it.
          const onRetiredTransport = row.type === 'inMemory'
          const headers = onRetiredTransport ? { ...row.headers, APP: 'Cherry Studio' } : (row.headers ?? {})
          const credential = hostedCredential(row, headers)

          tx.update(mcpServerTable)
            .set({
              installSource: 'manual',
              type: onRetiredTransport ? 'streamableHttp' : row.type,
              baseUrl: onRetiredTransport ? hosted.baseUrl : row.baseUrl,
              headers: credential.headers,
              env: credential.env
            })
            .where(eq(mcpServerTable.id, row.id))
            .run()
          continue
        }

        if (!(RETIRED_IN_MEMORY_NAMES as readonly string[]).includes(row.name)) continue
        inMemoryIds.push(row.id)
      }

      if (!inMemoryIds.length) return

      tx.delete(agentMcpServerTable).where(inArray(agentMcpServerTable.mcpServerId, inMemoryIds)).run()
      tx.delete(assistantMcpServerTable).where(inArray(assistantMcpServerTable.mcpServerId, inMemoryIds)).run()
      tx.delete(mcpServerTable).where(inArray(mcpServerTable.id, inMemoryIds)).run()
    })
  }
}
