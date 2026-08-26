import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REQUIRED_HOST_OWNERS } from './support.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const runner = join(projectRoot, 'acceptance', 'full-p0', 'host-owner-gate.mjs')
const receiptPath = join(projectRoot, '.artifacts', 'acceptance', 'full-p0-host-owner-gate', 'receipt.json')
const expected = REQUIRED_HOST_OWNERS[0].failureCode

const exitCode = await new Promise((resolveExit, rejectExit) => {
  const child = spawn(process.execPath, [runner], { cwd: projectRoot, stdio: 'inherit' })
  child.once('error', rejectExit)
  child.once('exit', (code, signal) => {
    if (signal !== null) rejectExit(new Error(`Host negative runner terminated by ${signal}`))
    else resolveExit(code)
  })
})

const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
if (exitCode !== 1
  || receipt.status !== 'failed'
  || receipt.p0Status !== 'not-proven'
  || receipt.expectedFirstRed !== expected
  || receipt.failure?.code !== expected) {
  throw new Error(`published Host negative lane was not the exact expected Red: ${JSON.stringify({ exitCode, receipt })}`)
}

process.stdout.write(`Published rc.2 negative lane verified: ${expected}\n`)
