import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { SdkError, SdkErrorCode, SdkHttpError, UnauthorizedError } from '@modelcontextprotocol/client'
import { createMcpHandler, Server } from '@modelcontextprotocol/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('electron', () => ({
  app: {
    getLocale: () => 'en-US',
    getPreferredSystemLanguages: () => ['en-US']
  },
  net: { fetch: fetchMock },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import { application } from '@application'
import type { McpServer } from '@shared/data/types/mcpServer'

import { McpAuthorizationCompleted, McpOAuthCoordinator } from '../../oauth/McpOAuthCoordinator'
import { McpOAuthClientProvider } from '../../oauth/provider'
import { oauthServerUrlHash } from '../../oauth/storage'
import { createExternalMcpConnection, externalMcpConnectionInternals } from '../ExternalMcpConnection'
import { fetchMcpHandler } from './fetchMcpHandler'

const probeRejectionBody = JSON.stringify({
  jsonRpcError: {
    code: -32603,
    message: 'Failed to handle request: Missing handler for request type: server/discover'
  },
  cause: null,
  localizedMessage: 'Failed to handle request',
  message: 'Failed to handle request'
})

const events = {
  toolsChanged: vi.fn(),
  promptsChanged: vi.fn(),
  resourcesChanged: vi.fn(),
  resourceUpdated: vi.fn(),
  log: vi.fn()
}

const server = {
  id: 'mx-ds-mcp',
  name: 'mx-ds-mcp',
  baseUrl: 'https://mx-ds-mcp.test/mcp',
  type: 'streamableHttp',
  headers: { Authorization: 'Bearer fixture' },
  isActive: true
} as McpServer

const createLog = () => ({ info: vi.fn(), warn: vi.fn(), stdio: vi.fn() })

function createLegacyHandler() {
  return createMcpHandler(
    () => {
      const mcp = new Server({ name: 'mx-ds-mcp', version: '1' }, { capabilities: { tools: {} } })
      mcp.setRequestHandler('tools/list', async () => ({
        tools: [{ name: 'mx_quote', inputSchema: { type: 'object' } }]
      }))
      return mcp
    },
    { legacy: 'stateless' }
  )
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('ExternalMcpConnection transport fallback policy', () => {
  it('coalesces authorization before credentials can be overwritten and releases failed attempts', async () => {
    const coordinator = new McpOAuthCoordinator()
    const controller = new AbortController()
    const first = await coordinator.begin('target', controller.signal)
    const concurrent = coordinator.begin('target', controller.signal)
    first.finish()
    await expect(concurrent).rejects.toBeInstanceOf(McpAuthorizationCompleted)
    const retry = await coordinator.begin('target', controller.signal)
    const waiting = coordinator.begin('target', controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(waiting).rejects.toThrow('cancelled')
    expect(retry.signal.aborted).toBe(true)
    const fresh = await coordinator.begin('target', new AbortController().signal)
    coordinator.close()
    expect(fresh.signal.aborted).toBe(true)
  })
  it('tries the configured URL transport before its compatibility fallback', () => {
    const server = {
      baseUrl: 'https://example.com/mcp',
      type: 'sse'
    } as McpServer
    expect(externalMcpConnectionInternals.transportCandidates(server)).toEqual(['sse', 'streamableHttp'])

    server.type = 'streamableHttp'
    expect(externalMcpConnectionInternals.transportCandidates(server)).toEqual(['streamableHttp', 'sse'])
  })

  it('falls back only for endpoint-shape mismatch status codes', () => {
    expect(
      externalMcpConnectionInternals.isTransportFallbackError(
        new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, 'HTTP request failed', { status: 405 })
      )
    ).toBe(true)
    expect(
      externalMcpConnectionInternals.isTransportFallbackError(
        new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, 'Unauthorized', { status: 401 })
      )
    ).toBe(false)
    expect(externalMcpConnectionInternals.isTransportFallbackError(new Error('network unavailable'))).toBe(false)
  })

  it('signs in through OAuth when the server carries no static credential', () => {
    expect(externalMcpConnectionInternals.prefersOAuth({ headers: {} })).toBe(true)
    expect(externalMcpConnectionInternals.prefersOAuth({ headers: { APP: 'Cherry Studio' } })).toBe(true)
  })

  it('authenticates with the header when the server carries one', () => {
    expect(externalMcpConnectionInternals.prefersOAuth({ headers: { Authorization: 'Bearer fixture' } })).toBe(false)
    // The header reaches here unnormalized, so the match is case-insensitive.
    expect(externalMcpConnectionInternals.prefersOAuth({ headers: { authorization: 'Bearer fixture' } })).toBe(false)
  })

  it('signs in through OAuth when the server carries no static credential', async () => {
    const oauthDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-test-'))
    const getPathSpy = vi
      .spyOn(application, 'getPath')
      .mockImplementation((key: string, filename?: string) =>
        key === 'feature.mcp.oauth'
          ? path.resolve(oauthDir, filename ?? '')
          : path.resolve('/mock', key, filename ?? '')
      )
    const oauthUrl = 'https://mcp.example.com/mcp'
    const authIssuer = 'https://auth.example.com'
    const oauthServer: McpServer = {
      id: 'oauth-1',
      name: 'oauth-server',
      type: 'streamableHttp',
      baseUrl: oauthUrl,
      headers: { APP: 'Cherry Studio' },
      isActive: true
    }

    const handler = createLegacyHandler()
    try {
      const mcpAuthHeaders: Array<string | null> = []
      const oauthAuthHeaders: Array<{ url: string; authorization: string | null }> = []

      // 1. A cached OAuth token is used and refreshed when it expires.
      const seedProvider = new McpOAuthClientProvider({
        serverUrlHash: oauthServerUrlHash(oauthUrl),
        configDir: oauthDir
      })
      await seedProvider.saveClientInformation(
        { client_id: 'public-client', issuer: authIssuer },
        { issuer: authIssuer }
      )
      await seedProvider.saveTokens(
        {
          access_token: 'expired-oauth-token',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          issuer: authIssuer
        },
        { issuer: authIssuer }
      )

      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = request.url
        const authHeader = request.headers.get('authorization')

        if (url === oauthUrl) {
          mcpAuthHeaders.push(authHeader)
          if (authHeader !== 'Bearer fresh-oauth-token') {
            return new Response(null, {
              status: 401,
              headers: {
                'WWW-Authenticate':
                  'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"'
              }
            })
          }
          return fetchMcpHandler(handler, input, init)
        }

        oauthAuthHeaders.push({ url, authorization: authHeader })
        if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
          return Response.json({ resource: oauthUrl, authorization_servers: [authIssuer] })
        }
        if (url === `${authIssuer}/.well-known/oauth-authorization-server`) {
          return Response.json({
            issuer: authIssuer,
            authorization_endpoint: `${authIssuer}/oauth/authorize`,
            token_endpoint: `${authIssuer}/oauth/token`,
            registration_endpoint: `${authIssuer}/oauth/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['none'],
            code_challenge_methods_supported: ['S256']
          })
        }
        if (url === `${authIssuer}/oauth/token`) {
          // A public-client AS rejects `/oauth/token` with 401 invalid_client if any Bearer header is present.
          if (authHeader) {
            return Response.json(
              { error: 'invalid_client', error_description: 'HTTP Basic client authentication is required' },
              { status: 401 }
            )
          }
          return Response.json({
            access_token: 'fresh-oauth-token',
            refresh_token: 'refresh-2',
            token_type: 'Bearer'
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      })

      const refreshedConnection = await createExternalMcpConnection({
        server: oauthServer,
        appVersion: '0.0.0-test',
        events,
        log: createLog(),
        allowInteractiveAuthorization: false,
        connectTimeoutMs: 5_000
      })
      try {
        expect((await refreshedConnection.listTools()).map((tool) => tool.name)).toContain('mx_quote')
        // The cached token was used first and then refreshed cleanly.
        expect(mcpAuthHeaders[0]).toBe('Bearer expired-oauth-token')
        expect(mcpAuthHeaders).toContain('Bearer fresh-oauth-token')
        // No credential reaches the OAuth endpoints.
        expect(oauthAuthHeaders.length).toBeGreaterThan(0)
        expect(oauthAuthHeaders.every((entry) => entry.authorization === null)).toBe(true)
      } finally {
        await refreshedConnection.close()
      }

      // 2. With no OAuth session yet, the MCP endpoint is called without a credential and
      //    the sign-in flow yields UnauthorizedError in background mode.
      await seedProvider.invalidateCredentials('all')
      mcpAuthHeaders.length = 0
      oauthAuthHeaders.length = 0

      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = request.url
        const authHeader = request.headers.get('authorization')

        if (url === oauthUrl) {
          mcpAuthHeaders.push(authHeader)
          return new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"'
            }
          })
        }

        oauthAuthHeaders.push({ url, authorization: authHeader })
        if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
          return Response.json({ resource: oauthUrl, authorization_servers: [authIssuer] })
        }
        if (url === `${authIssuer}/.well-known/oauth-authorization-server`) {
          return Response.json({
            issuer: authIssuer,
            authorization_endpoint: `${authIssuer}/oauth/authorize`,
            token_endpoint: `${authIssuer}/oauth/token`,
            registration_endpoint: `${authIssuer}/oauth/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['none'],
            code_challenge_methods_supported: ['S256']
          })
        }
        if (url === `${authIssuer}/oauth/register`) {
          return Response.json({ ...seedProvider.clientMetadata, client_id: 'registered-client' })
        }
        throw new Error(`Unexpected request: ${url}`)
      })

      await expect(
        createExternalMcpConnection({
          server: oauthServer,
          appVersion: '0.0.0-test',
          events,
          log: createLog(),
          allowInteractiveAuthorization: false,
          connectTimeoutMs: 5_000
        })
      ).rejects.toSatisfy((err) => UnauthorizedError.isInstance(err))
      expect(mcpAuthHeaders[0]).toBeNull()
      expect(oauthAuthHeaders.every((entry) => entry.authorization === null)).toBe(true)
    } finally {
      getPathSpy.mockRestore()
      await handler.close()
      await fs.rm(oauthDir, { recursive: true, force: true })
    }
  })

  it('authenticates with the static header and skips the sign-in flow', async () => {
    const handler = createLegacyHandler()
    const mcpAuthHeaders: Array<string | null> = []
    let oauthRequests = 0

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = request.url
      if (url === 'https://mcp.example.com/mcp') {
        mcpAuthHeaders.push(request.headers.get('authorization'))
        return fetchMcpHandler(handler, input, init)
      }
      oauthRequests += 1
      throw new Error(`Unexpected request: ${url}`)
    })

    try {
      const connection = await createExternalMcpConnection({
        server: {
          id: 'static-1',
          name: 'static-server',
          type: 'streamableHttp',
          baseUrl: 'https://mcp.example.com/mcp',
          headers: { APP: 'Cherry Studio', Authorization: 'Bearer static-key' },
          isActive: true
        },
        appVersion: '0.0.0-test',
        events,
        log: createLog(),
        allowInteractiveAuthorization: false,
        connectTimeoutMs: 5_000
      })
      try {
        expect((await connection.listTools()).map((tool) => tool.name)).toContain('mx_quote')
        expect(mcpAuthHeaders.every((header) => header === 'Bearer static-key')).toBe(true)
        expect(oauthRequests).toBe(0)
      } finally {
        await connection.close()
      }
    } finally {
      await handler.close()
    }
  })
})

describe('ExternalMcpConnection legacy probe rejection', () => {
  it('connects and lists tools when a legacy server rejects server/discover with HTTP 500', async () => {
    const handler = createLegacyHandler()
    const log = createLog()
    let rejectedProbes = 0
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.method === 'POST' && (await request.clone().json()).method === 'server/discover') {
        rejectedProbes++
        return new Response(probeRejectionBody, { status: 500 })
      }
      return fetchMcpHandler(handler, input, init)
    })
    try {
      const connection = await createExternalMcpConnection({
        server,
        appVersion: '0.0.0-test',
        events,
        log,
        connectTimeoutMs: 5_000
      })
      try {
        expect(connection.era).toBe('legacy')
        expect((await connection.listTools()).map((tool) => tool.name)).toContain('mx_quote')
        expect(rejectedProbes).toBeGreaterThan(0)
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('legacy'), expect.anything())
      } finally {
        await connection.close()
      }
    } finally {
      await handler.close()
    }
  })

  it('connects as legacy when server/discover returns an HTML 5xx body', async () => {
    const handler = createLegacyHandler()
    const log = createLog()
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.method === 'POST' && (await request.clone().json()).method === 'server/discover') {
        return new Response('<html>502 Bad Gateway</html>', { status: 500 })
      }
      return fetchMcpHandler(handler, input, init)
    })
    try {
      const connection = await createExternalMcpConnection({
        server,
        appVersion: '0.0.0-test',
        events,
        log,
        connectTimeoutMs: 5_000
      })
      try {
        expect(connection.era).toBe('legacy')
        expect((await connection.listTools()).map((tool) => tool.name)).toContain('mx_quote')
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('legacy'), expect.anything())
      } finally {
        await connection.close()
      }
    } finally {
      await handler.close()
    }
  })

  it('connects as legacy when server/discover returns a bare empty 5xx body', async () => {
    const handler = createLegacyHandler()
    const log = createLog()
    let rejectedProbes = 0
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.method === 'POST' && (await request.clone().json()).method === 'server/discover') {
        rejectedProbes++
        return new Response(null, {
          status: 500,
          headers: { 'content-type': 'application/json;charset=utf-8' }
        })
      }
      return fetchMcpHandler(handler, input, init)
    })
    try {
      const connection = await createExternalMcpConnection({
        server,
        appVersion: '0.0.0-test',
        events,
        log,
        connectTimeoutMs: 5_000
      })
      try {
        expect(connection.era).toBe('legacy')
        expect((await connection.listTools()).map((tool) => tool.name)).toContain('mx_quote')
        expect(rejectedProbes).toBeGreaterThan(0)
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('legacy'), expect.anything())
      } finally {
        await connection.close()
      }
    } finally {
      await handler.close()
    }
  })

  it('returns the original probe error if the legacy handshake also fails', async () => {
    const handler = createLegacyHandler()
    const log = createLog()
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.method === 'POST') {
        const method = (await request.clone().json()).method
        if (method === 'server/discover') return new Response(probeRejectionBody, { status: 500 })
        if (method === 'initialize') return new Response('<html>502 Bad Gateway</html>', { status: 502 })
      }
      return fetchMcpHandler(handler, input, init)
    })
    try {
      const error = await createExternalMcpConnection({
        server,
        appVersion: '0.0.0-test',
        events,
        log,
        connectTimeoutMs: 5_000
      }).then(
        () => null,
        (rejection: unknown) => rejection
      )
      expect(SdkHttpError.isInstance(error)).toBe(true)
      expect(error).toMatchObject({ code: SdkErrorCode.EraNegotiationFailed, status: 500 })
      expect(log.warn).toHaveBeenCalledWith('Legacy retry failed', expect.anything())
    } finally {
      await handler.close()
    }
  })

  it('keeps a modern server on the modern connection path', async () => {
    const handler = createMcpHandler(
      () => new Server({ name: 'modern-mcp', version: '1' }, { capabilities: { tools: {} } }),
      { legacy: 'reject' }
    )
    const log = createLog()
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      fetchMcpHandler(handler, input, init)
    )
    try {
      const connection = await createExternalMcpConnection({
        server,
        appVersion: '0.0.0-test',
        events,
        log,
        connectTimeoutMs: 5_000
      })
      try {
        expect(connection.era).toBe('modern')
        expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('legacy'), expect.anything())
      } finally {
        await connection.close()
      }
    } finally {
      await handler.close()
    }
  })

  it('does not retry a network failure as legacy', async () => {
    fetchMock.mockRejectedValue(new Error('network unavailable'))
    const log = createLog()
    const error = await createExternalMcpConnection({
      server,
      appVersion: '0.0.0-test',
      events,
      log,
      connectTimeoutMs: 5_000
    }).then(
      () => null,
      (rejection: unknown) => rejection
    )
    expect(error).not.toBeNull()
    expect(SdkHttpError.isInstance(error)).toBe(false)
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('legacy'), expect.anything())
  })

  it('keeps HTTP 401 as an authentication failure', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    const error = await createExternalMcpConnection({
      server,
      appVersion: '0.0.0-test',
      events,
      log: createLog(),
      connectTimeoutMs: 5_000
    }).then(
      () => null,
      (rejection: unknown) => rejection
    )
    expect(SdkHttpError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({ code: SdkErrorCode.ClientHttpAuthentication, status: 401 })
  })

  it.each([
    ['reporter wrapper', probeRejectionBody],
    ['standard error envelope', '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"missing handler"}}'],
    ['arbitrary wrapper', '{"problem":{"code":-32000,"message":"unsupported method"}}']
  ])('recognizes a protocol error in the %s', (_name, text) => {
    expect(
      externalMcpConnectionInternals.isLegacyProbeRejection(
        new SdkHttpError(SdkErrorCode.EraNegotiationFailed, 'Probe failed', { status: 500, statusText: '', text })
      )
    ).toBe(true)
  })

  it.each([
    ['HTML body', SdkErrorCode.EraNegotiationFailed, 500, '<html>502 Bad Gateway</html>'],
    ['HTTP error code', SdkErrorCode.EraNegotiationFailed, 500, '{"code":500,"message":"Internal Server Error"}'],
    ['empty body', SdkErrorCode.EraNegotiationFailed, 500, ''],
    ['invalid JSON', SdkErrorCode.EraNegotiationFailed, 500, 'not JSON'],
    ['non-integer error code', SdkErrorCode.EraNegotiationFailed, 500, '{"error":{"code":-32603.5,"message":"bad"}}'],
    ['missing error message', SdkErrorCode.EraNegotiationFailed, 500, '{"error":{"code":-32603}}'],
    ['undefined text', SdkErrorCode.EraNegotiationFailed, 500, undefined]
  ])('recognizes a bare probe 5xx for %s', (_name, code, status, text) => {
    expect(
      externalMcpConnectionInternals.isLegacyProbeRejection(
        new SdkHttpError(code, 'Probe failed', { status, statusText: '', text })
      )
    ).toBe(true)
  })

  it.each([
    ['HTTP 404', SdkErrorCode.EraNegotiationFailed, 404, probeRejectionBody],
    ['HTTP 401', SdkErrorCode.ClientHttpAuthentication, 401, probeRejectionBody],
    ['HTTP 403', SdkErrorCode.ClientHttpForbidden, 403, probeRejectionBody],
    ['authentication code with HTTP 500', SdkErrorCode.ClientHttpAuthentication, 500, probeRejectionBody]
  ])('rejects %s as legacy probe evidence', (_name, code, status, text) => {
    expect(
      externalMcpConnectionInternals.isLegacyProbeRejection(
        new SdkHttpError(code, 'Probe failed', { status, statusText: '', text })
      )
    ).toBe(false)
  })

  it('rejects network and non-HTTP SDK errors as legacy probe evidence', () => {
    expect(externalMcpConnectionInternals.isLegacyProbeRejection(new Error('network unavailable'))).toBe(false)
    expect(
      externalMcpConnectionInternals.isLegacyProbeRejection(
        new SdkError(SdkErrorCode.EraNegotiationFailed, 'Version negotiation probe failed: network unavailable')
      )
    ).toBe(false)
  })
})
