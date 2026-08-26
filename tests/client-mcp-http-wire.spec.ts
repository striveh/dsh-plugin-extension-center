import { describe, expect, it } from 'vitest'
import { parseConfigurationOptionsResponse } from '../src/client/management-api.ts'

const option = {
  candidateRef: 'mcp:remote-query@1.0.0',
  runtimeRef: 'runtime:https:remote-query-v1',
  version: '1.0.0',
  transport: 'streamable-http',
  origin: 'https://mcp.example.test',
  endpoint: 'https://mcp.example.test/mcp/v1',
  authentication: 'none',
  redirects: 'forbidden',
  dataEgressDisclosure: 'Tool names, arguments, and session metadata leave this Host for mcp.example.test.',
} as const

function response(value: unknown = option): unknown {
  return { protocolVersion: 1, options: [value], currentConfiguration: null }
}

describe('Streamable HTTPS MCP option wire validation', () => {
  it('accepts only the exact zero-secret canonical HTTPS selector facts', () => {
    expect(parseConfigurationOptionsResponse(response())).toEqual(response())
  })

  it.each([
    ['plain HTTP', { ...option, endpoint: 'http://mcp.example.test/mcp/v1' }],
    ['noncanonical host', { ...option, endpoint: 'https://MCP.EXAMPLE.TEST/mcp/v1' }],
    ['URL credentials', { ...option, endpoint: 'https://user:secret@mcp.example.test/mcp/v1' }],
    ['different origin', { ...option, origin: 'https://different.example.test' }],
    ['authentication', { ...option, authentication: 'bearer' }],
    ['redirect following', { ...option, redirects: 'follow' }],
    ['custom headers', { ...option, headers: { Authorization: 'Bearer secret' } }],
    ['environment secret', { ...option, env: { TOKEN: 'secret' } }],
  ])('rejects %s', (_label, invalid) => {
    expect(() => parseConfigurationOptionsResponse(response(invalid))).toThrow()
  })
})
