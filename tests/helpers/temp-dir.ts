import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TestTempDir {
  path: string
  cleanup(): void
}

/**
 * Creates a test-owned folder under the OS temp directory. Production data/
 * and modules/ are never suitable scratch locations for tests.
 */
export function createTestTempDir(label = 'case'): TestTempDir {
  const path = mkdtempSync(join(tmpdir(), `bored-manager-${label}-`))
  let removed = false
  return {
    path,
    cleanup: () => {
      if (removed) return
      removed = true
      rmSync(path, { recursive: true, force: true })
    }
  }
}

export async function withTestTempDir<T>(
  run: (path: string) => T | Promise<T>,
  label?: string
): Promise<T> {
  const dir = createTestTempDir(label)
  try {
    return await run(dir.path)
  } finally {
    dir.cleanup()
  }
}
