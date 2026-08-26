import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const libRoot = fileURLToPath(new URL('../lib/', import.meta.url))

/** Normalize generated text artifacts to one trailing newline. */
async function normalize(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await normalize(path)
      continue
    }
    if (!/\.(?:js|map|ts)$/u.test(entry.name)) continue
    const text = await readFile(path, 'utf8')
    const normalized = `${text.replace(/[\r\n]*$/u, '')}\n`
    if (normalized !== text) await writeFile(path, normalized)
  }
}

await normalize(libRoot)
