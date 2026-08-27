/**
 * Track the exact browser interval whose Extension Center traffic is evidence.
 * @returns {{start: () => void, finish: () => void, isActive: () => boolean, shouldClassifyRpc: (method: string, pathname: string) => boolean}} Journey window controls.
 */
export function createStoreJourneyWindow() {
  let active = false
  return Object.freeze({
    start() {
      if (active) throw new Error('Store journey evidence window is already active')
      active = true
    },
    finish() {
      active = false
    },
    isActive() {
      return active
    },
    shouldClassifyRpc(method, pathname) {
      return active
        && pathname.startsWith('/dsh-extension-center/')
        && !['GET', 'HEAD', 'OPTIONS'].includes(method)
    },
  })
}

/**
 * Read fail-closed card evidence by exact candidate identity from rendered Store DOM.
 * @param {Element} storePanel Rendered Store panel.
 * @param {readonly string[]} expectedCandidateRefs Exact MCP candidate references.
 * @returns {Array<{expectedCandidateRef: string, observedCandidateRef: string | null, cardCount: number, kindMarkerCount: number, unavailableButtonCount: number, unavailableDisabled: boolean, unavailableTitle: string | null, addConnectionButtonCount: number}>} Per-candidate DOM evidence.
 */
export function collectFailClosedMcpCardEvidence(storePanel, expectedCandidateRefs) {
  const cards = [...storePanel.querySelectorAll('article[data-candidate-ref]')]
  return expectedCandidateRefs.map(expectedCandidateRef => {
    const matches = cards.filter(card => card.getAttribute('data-candidate-ref') === expectedCandidateRef)
    const card = matches.length === 1 ? matches[0] : null
    const buttons = card === null ? [] : [...card.querySelectorAll('button')]
    const unavailableButtons = buttons.filter(button => button.textContent?.trim() === 'Acquire unavailable')
    const unavailable = unavailableButtons.length === 1 ? unavailableButtons[0] : null
    return {
      expectedCandidateRef,
      observedCandidateRef: card?.getAttribute('data-candidate-ref') ?? null,
      cardCount: matches.length,
      kindMarkerCount: card === null
        ? 0
        : [...card.querySelectorAll('[data-kind]')].filter(marker => marker.getAttribute('data-kind') === 'mcp').length,
      unavailableButtonCount: unavailableButtons.length,
      unavailableDisabled: unavailable?.hasAttribute('disabled') ?? false,
      unavailableTitle: unavailable?.getAttribute('title') ?? null,
      addConnectionButtonCount: buttons.filter(button => button.textContent?.trim() === 'Add connection').length,
    }
  })
}

/**
 * Explain the first exact-candidate fail-closed violation.
 * @param {ReturnType<typeof collectFailClosedMcpCardEvidence>} evidence Per-candidate DOM evidence.
 * @returns {string | null} Failure detail, or null when every exact card fails closed.
 */
export function failClosedMcpCardEvidenceError(evidence) {
  for (const entry of evidence) {
    if (entry.cardCount !== 1 || entry.observedCandidateRef !== entry.expectedCandidateRef) {
      return `${entry.expectedCandidateRef} did not resolve to one exact candidate card`
    }
    if (entry.kindMarkerCount !== 1) return `${entry.expectedCandidateRef} was not rendered as one MCP candidate`
    if (
      entry.unavailableButtonCount !== 1
      || !entry.unavailableDisabled
      || entry.unavailableTitle !== 'No admitted runtime is provisioned'
      || entry.addConnectionButtonCount !== 0
    ) {
      return `${entry.expectedCandidateRef} did not expose only its exact fail-closed acquisition entry`
    }
  }
  return null
}
