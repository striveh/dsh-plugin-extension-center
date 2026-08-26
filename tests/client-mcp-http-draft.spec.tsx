import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { McpConfigurationDraft } from '../src/client/TypedConfigurationDrafts.tsx'
import { en, type ExtensionCenterKey } from '../src/client/locales.ts'

const t = (key: ExtensionCenterKey) => en[key]

describe('typed Streamable HTTPS MCP configuration', () => {
  it('discloses the fixed destination but saves only its opaque selector and bounded connection policy', () => {
    const onSave = vi.fn()
    render(<McpConfigurationDraft
      options={[{
        candidateRef: 'mcp:example/remote@1.0.0',
        runtimeRef: 'runtime:https:remote-v1',
        version: '1.0.0',
        transport: 'streamable-http',
        origin: 'https://mcp.example.test',
        endpoint: 'https://mcp.example.test/mcp',
        authentication: 'none',
        redirects: 'forbidden',
        dataEgressDisclosure: 'Tool names, arguments, and MCP session metadata leave this Host.',
      }]}
      initial={null}
      t={t}
      onSave={onSave}
      onDiscard={() => {}}
    />)

    const draft = screen.getByRole('heading', { name: 'MCP connection settings' }).closest('section')!
    expect(within(draft).getByText('https://mcp.example.test')).toBeVisible()
    expect(within(draft).getByText('https://mcp.example.test/mcp')).toBeVisible()
    expect(within(draft).getByText(/Tool names, arguments/)).toBeVisible()
    expect(within(draft).getByText(/redirects fail closed/)).toBeVisible()
    expect(within(draft).queryByRole('textbox', { name: /Allowed filesystem roots/ })).toBeNull()
    expect(within(draft).queryByRole('textbox', { name: /URL|header|credential/i })).toBeNull()

    fireEvent.change(within(draft).getByRole('textbox', { name: 'Connection name' }), { target: { value: 'remote' } })
    fireEvent.click(within(draft).getByRole('button', { name: 'Save and review' }))
    expect(onSave).toHaveBeenCalledWith({
      transport: 'streamable-http',
      connectionId: 'remote',
      runtimeRef: 'runtime:https:remote-v1',
      toolCallTimeoutMs: 30_000,
      reconnect: { enabled: true, initialDelayMs: 250, maxDelayMs: 5_000, maxAttempts: 8 },
    })
    const saved = onSave.mock.calls[0]![0]
    expect(saved).not.toHaveProperty('url')
    expect(saved).not.toHaveProperty('origin')
    expect(saved).not.toHaveProperty('headers')
    expect(saved).not.toHaveProperty('credentials')
    expect(saved).not.toHaveProperty('roots')
  })
})
