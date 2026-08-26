import { rm } from 'node:fs/promises'

await rm(new URL('../lib/.build/', import.meta.url), { recursive: true, force: true })
