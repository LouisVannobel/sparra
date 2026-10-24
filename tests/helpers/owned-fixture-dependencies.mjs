import { mkdirSync, readdirSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

function linkFixturePackage(from, to) {
  const code = realpathSync(from)
  if (!statSync(code).isDirectory()) throw new Error('Fixture package directory required')
  symlinkSync(code, to, process.platform === 'win32' ? 'junction' : 'dir')
}

function linkFixtureScope(source, target) {
  mkdirSync(target)
  for (const name of readdirSync(source)) {
    if (!name.startsWith('.')) linkFixturePackage(join(source, name), join(target, name))
  }
}

// Only package code and executable shims are shared. The modules directory,
// scope directories and every tool-created cache/config temporary path are owned.
// The caller owns the new fixture root and its existing checked cleanup boundary.
export function createOwnedFixtureDependencies(fixtureRoot, toolingRoot) {
  const source = join(toolingRoot, 'node_modules')
  const target = join(fixtureRoot, 'node_modules')
  mkdirSync(target)
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.bin') { linkFixturePackage(join(source, entry.name), join(target, entry.name)); continue }
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      linkFixtureScope(join(source, entry.name), join(target, entry.name))
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      linkFixturePackage(join(source, entry.name), join(target, entry.name))
    }
  }
}
