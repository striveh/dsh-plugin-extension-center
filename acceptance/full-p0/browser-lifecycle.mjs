import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

/** Exercise one real, user-approved Skill installation through the packed Web Client. */
export async function installSkillThroughBrowser(options) {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    locale: 'en-US',
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 1000 },
  })
  const observedMethods = []
  const externalRequests = []
  const consoleFailures = []
  let interceptionFailure
  let afterPlanObserved = false
  let beforeLifecycleObserved = false
  try {
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (!isLocalBrowserResource(url, options.origin)) {
        externalRequests.push(`${request.method()} ${url.protocol}//${url.host}${url.pathname}`)
        await route.abort('blockedbyclient')
        return
      }
      if (request.method() === 'POST' && url.pathname.startsWith('/dsh-extension-center/')) {
        let payload
        try {
          payload = request.postDataJSON()
        } catch {
          payload = null
        }
        const method = payload?.method
        if (typeof method === 'string') {
          observedMethods.push(method)
          if (method === 'lifecycle/request') {
            try {
              await options.beforeLifecycle()
              beforeLifecycleObserved = true
            } catch (error) {
              interceptionFailure = error
              await route.abort('failed')
              return
            }
          }
        }
      }
      await route.continue()
    })
    await context.routeWebSocket('**/*', async websocket => {
      const url = new URL(websocket.url())
      if (url.origin === options.origin.replace(/^http/u, 'ws')) {
        websocket.connectToServer()
        return
      }
      externalRequests.push(`WEBSOCKET ${url.protocol}//${url.host}${url.pathname}`)
      await websocket.close({ code: 1008, reason: 'external browser connection denied by P0 acceptance' })
    })
    const page = await context.newPage()
    page.on('pageerror', error => consoleFailures.push(`pageerror: ${error.message}`))
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') {
        consoleFailures.push(`${message.type()}: ${message.text()}`)
      }
    })
    await page.goto(options.origin, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.locator('body').waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForFunction(
      pluginId => globalThis.__DSH_BOOT__?.entries?.some(entry => entry.id === pluginId) === true,
      'dsh-plugin-extension-center',
      { timeout: 30_000 },
    )
    await dismissHostOnboarding(page)

    const trigger = page.getByRole('button', { name: 'Extensions', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Extension Store', exact: true })
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })
    const store = dialog.getByRole('tabpanel', { name: 'Store', exact: true })
    const card = store.getByRole('heading', { name: options.skillName, exact: true }).locator('xpath=ancestor::article[1]')
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    await card.getByRole('combobox', { name: 'Target scope', exact: true }).selectOption('user')
    await card.getByRole('button', { name: 'Review install', exact: true }).click()
    const draftHeading = store.getByRole('heading', { name: 'Skill target settings', exact: true })
    await draftHeading.waitFor({ state: 'visible', timeout: 10_000 })
    const previewResponse = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/dsh-extension-center/intent/preview'
    ), { timeout: 30_000 })
    await store.getByRole('button', { name: 'Save and review', exact: true }).click()
    const preview = await businessValue(await previewResponse, 'intent/preview')

    const reviewHeading = store.getByRole('heading', { name: 'Review exact lifecycle plan', exact: true })
    await reviewHeading.waitFor({ state: 'visible', timeout: 30_000 })
    const review = reviewHeading.locator('xpath=ancestor::section[1]')
    await options.afterPlan()
    afterPlanObserved = true
    await page.screenshot({ path: options.reviewScreenshotPath, fullPage: true })
    const decisionResponse = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/dsh-extension-center/plan/decide'
    ), { timeout: 30_000 })
    const lifecycleResponse = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/dsh-extension-center/lifecycle/request'
    ), { timeout: 120_000 })
    await review.getByRole('button', { name: 'Approve exact plan', exact: true }).click()
    const decision = await businessValue(await decisionResponse, 'plan/decide')
    const lifecycle = await businessValue(await lifecycleResponse, 'lifecycle/request')
    await review.getByText('Lifecycle operation finished', { exact: true }).waitFor({ state: 'visible', timeout: 120_000 })
    await review.getByText('Receipt digest', { exact: false }).waitFor({ state: 'visible', timeout: 10_000 })
    await page.screenshot({ path: options.committedScreenshotPath, fullPage: true })
    await writeFile(options.ariaPath, await page.locator('body').ariaSnapshot())

    if (interceptionFailure !== undefined) throw interceptionFailure
    if (!afterPlanObserved || !beforeLifecycleObserved) {
      throw new Error('browser lifecycle did not cross both plan and approval observation points')
    }
    const writes = observedMethods.filter(method => ['intent/preview', 'plan/decide', 'lifecycle/request'].includes(method))
    if (JSON.stringify(writes) !== JSON.stringify(['intent/preview', 'plan/decide', 'lifecycle/request'])) {
      throw new Error(`browser lifecycle write order is invalid: ${writes.join(', ')}`)
    }
    if (externalRequests.length > 0) {
      throw new Error(`browser lifecycle attempted external requests: ${externalRequests.join(', ')}`)
    }
    if (consoleFailures.length > 0) throw new Error(`browser lifecycle console failed: ${consoleFailures.join('; ')}`)
    return Object.freeze({
      methods: Object.freeze([...observedMethods]),
      preview,
      decision,
      lifecycle,
    })
  } finally {
    await context.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
}

/** Approve one Agent-created acquisition plan through the real Activity surface. */
export async function approveTaskPlanThroughBrowser(options) {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    locale: 'en-US',
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 1000 },
  })
  const observedMethods = []
  const externalRequests = []
  const consoleFailures = []
  let interceptionFailure
  let beforeLifecycleObserved = false
  try {
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (!isLocalBrowserResource(url, options.origin)) {
        externalRequests.push(`${request.method()} ${url.protocol}//${url.host}${url.pathname}`)
        await route.abort('blockedbyclient')
        return
      }
      if (request.method() === 'POST' && url.pathname.startsWith('/dsh-extension-center/')) {
        let payload
        try {
          payload = request.postDataJSON()
        } catch {
          payload = null
        }
        const method = payload?.method
        if (typeof method === 'string') {
          observedMethods.push(method)
          if (method === 'lifecycle/request') {
            try {
              await options.beforeLifecycle()
              beforeLifecycleObserved = true
            } catch (error) {
              interceptionFailure = error
              await route.abort('failed')
              return
            }
          }
        }
      }
      await route.continue()
    })
    await context.routeWebSocket('**/*', async websocket => {
      const url = new URL(websocket.url())
      if (url.origin === options.origin.replace(/^http/u, 'ws')) {
        websocket.connectToServer()
        return
      }
      externalRequests.push(`WEBSOCKET ${url.protocol}//${url.host}${url.pathname}`)
      await websocket.close({ code: 1008, reason: 'external browser connection denied by P0 acceptance' })
    })
    const page = await context.newPage()
    page.on('pageerror', error => consoleFailures.push(`pageerror: ${error.message}`))
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') {
        consoleFailures.push(`${message.type()}: ${message.text()}`)
      }
    })
    await page.goto(options.origin, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.locator('body').waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForFunction(
      pluginId => globalThis.__DSH_BOOT__?.entries?.some(entry => entry.id === pluginId) === true,
      'dsh-plugin-extension-center',
      { timeout: 30_000 },
    )
    await dismissHostOnboarding(page)

    await page.getByRole('button', { name: 'Extensions', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Extension Store', exact: true })
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })
    await dialog.getByRole('tab', { name: 'Activity & Recovery', exact: true }).click()
    const activity = dialog.getByRole('tabpanel', { name: 'Activity & Recovery', exact: true })
    const approvalsHeading = activity.getByRole('heading', { name: 'Task acquisition approvals', exact: true })
    await approvalsHeading.waitFor({ state: 'visible', timeout: 30_000 })
    const approvals = approvalsHeading.locator('xpath=ancestor::section[1]')
    const approvalCard = approvals.locator('article').filter({ hasText: options.candidateRef })
    if (await approvalCard.count() !== 1) {
      throw new Error('Activity did not expose exactly one task approval for the requested candidate')
    }
    await activity.getByText(options.taskAttemptId, { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
    await approvalCard.getByRole('button', { name: 'Review task plan', exact: true }).click()
    const reviewHeading = activity.getByRole('heading', { name: 'Review exact lifecycle plan', exact: true })
    await reviewHeading.waitFor({ state: 'visible', timeout: 10_000 })
    const review = reviewHeading.locator('xpath=ancestor::section[1]')
    if (await review.getAttribute('data-plan-hash') !== options.planHash) {
      throw new Error('Activity opened a task plan with a different immutable hash')
    }
    await review.getByText(options.candidateRef, { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
    await options.afterPlan()
    await page.screenshot({ path: options.reviewScreenshotPath, fullPage: true })

    const decisionResponse = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/dsh-extension-center/plan/decide'
    ), { timeout: 30_000 })
    const lifecycleResponse = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/dsh-extension-center/lifecycle/request'
    ), { timeout: 120_000 })
    await review.getByRole('button', { name: 'Approve exact plan', exact: true }).click()
    const decision = await businessValue(await decisionResponse, 'plan/decide')
    const lifecycle = await businessValue(await lifecycleResponse, 'lifecycle/request')
    await reviewHeading.waitFor({ state: 'hidden', timeout: 30_000 })
    await activity.getByRole('heading', { name: 'Task acquisition approvals', exact: true }).waitFor({
      state: 'visible',
      timeout: 30_000,
    })
    await page.screenshot({ path: options.committedScreenshotPath, fullPage: true })
    await writeFile(options.ariaPath, await page.locator('body').ariaSnapshot())

    if (interceptionFailure !== undefined) throw interceptionFailure
    if (!beforeLifecycleObserved) throw new Error('browser task approval did not reach lifecycle execution')
    const writes = observedMethods.filter(method => ['plan/decide', 'lifecycle/request'].includes(method))
    if (JSON.stringify(writes) !== JSON.stringify(['plan/decide', 'lifecycle/request'])) {
      throw new Error(`browser task approval write order is invalid: ${writes.join(', ')}`)
    }
    if (decision.state?.plan?.hash !== options.planHash || decision.state?.status !== 'approved') {
      throw new Error('browser task approval did not bind the exact immutable plan')
    }
    if (lifecycle.status !== 'committed'
      || typeof lifecycle.operationId !== 'string'
      || typeof lifecycle.receipt?.digest !== 'string') {
      throw new Error('browser task approval lifecycle did not return one committed receipt')
    }
    if (externalRequests.length > 0) {
      throw new Error(`browser task approval attempted external requests: ${externalRequests.join(', ')}`)
    }
    if (consoleFailures.length > 0) throw new Error(`browser task approval console failed: ${consoleFailures.join('; ')}`)
    return Object.freeze({
      methods: Object.freeze([...observedMethods]),
      decision,
      lifecycle,
    })
  } finally {
    await context.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
}

async function businessValue(response, method) {
  const envelope = await response.json()
  const result = envelope?.result
  if (envelope?.type !== 'server-response' || result?.ok !== true || result.value === null
    || typeof result.value !== 'object' || Array.isArray(result.value)) {
    throw new Error(`${method} browser response was not one successful correlated business envelope`)
  }
  return result.value
}

function isLocalBrowserResource(url, origin) {
  return url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === origin
}

async function dismissHostOnboarding(page) {
  const testingNotice = page.getByRole('dialog', { name: 'Internal Testing Notice', exact: true })
  const providerSetup = page.getByRole('dialog', { name: 'Add an API key to get started', exact: true })
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await testingNotice.isVisible()) {
      await testingNotice.getByRole('button', { name: 'Continue', exact: true }).click()
      await testingNotice.waitFor({ state: 'hidden' })
    } else if (await providerSetup.isVisible()) {
      await providerSetup.getByRole('button', { name: 'Configure later', exact: true }).click()
      await providerSetup.waitFor({ state: 'hidden' })
    }
    await page.waitForTimeout(300)
    if (!(await testingNotice.isVisible()) && !(await providerSetup.isVisible())) return
  }
  throw new Error('latest official DSH onboarding did not settle for browser lifecycle acceptance')
}
