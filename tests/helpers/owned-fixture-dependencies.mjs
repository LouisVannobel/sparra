import { mkdirSync, readdirSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

// Only package code and executable shims are shared. The modules directory,
// scope directories and every tool-created cache/config temporary path are owned.
// The caller owns the new fixture root and its existing checked cleanup boundary.
export function createOwnedFixtureDependencies(fixtureRoot, toolingRoot) {
  const source = join(toolingRoot, 'node_modules')
  const target = join(fixtureRoot, 'node_modules')
  mkdirSync(target)
  const link = (from, to) => {
    const code = realpathSync(from)
    if (!statSync(code).isDirectory()) throw new Error('Fixture package directory required')
    symlinkSync(code, to, process.platform === 'win32' ? 'junction' : 'dir')
  }
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.bin') { link(join(source, entry.name), join(target, entry.name)); continue }
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      mkdirSync(join(target, entry.name))
      for (const scoped of readdirSync(join(source, entry.name))) {
        if (!scoped.startsWith('.')) link(join(source, entry.name, scoped), join(target, entry.name, scoped))
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      link(join(source, entry.name), join(target, entry.name))
    }
  }
}
