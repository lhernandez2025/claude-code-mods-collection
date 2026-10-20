// Guards the wiring between Claude Code and the code: manifests, the hooks module and its contract.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPO = path.join(ROOT, '..', '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const readJson = (file) => JSON.parse(read(file))

/** Every file a module pulls in through relative imports, recursively. */
function importGraph (file, seen = new Set()) {
  if (seen.has(file)) return seen
  seen.add(file)
  for (const [, spec] of read(file).matchAll(/^import (?!type )[^'"]*['"]([^'"]+)['"]/gm)) {
    if (spec.startsWith('.')) importGraph(path.relative(ROOT, path.resolve(ROOT, path.dirname(file), spec)), seen)
  }
  return seen
}

describe('plugin wiring', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  const plugin = readJson('.claude-plugin/plugin.json')
  const marketplace = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'))
  const hooks = readJson('hooks/hooks.json')

  test('versions and names agree everywhere', () => {
    assert.equal(plugin.name, 'after')
    assert.equal(plugin.version, pkg.version)
    const entry = marketplace.plugins.find((p) => p.name === plugin.name)
    assert.ok(entry, 'the repository marketplace lists after')
    assert.equal(entry.source, './plugins/after')
    assert.equal(entry.version, pkg.version)
  })

  test('has no runtime dependencies', () => {
    assert.equal(pkg.dependencies, undefined)
    assert.equal(pkg.devDependencies, undefined)
  })

  test('is a mod: one hooks module, no command hooks', () => {
    assert.deepEqual(Object.keys(hooks), ['modules'])
    assert.equal(hooks.modules.length, 1)
    assert.ok(fs.existsSync(path.join(ROOT, 'hooks', hooks.modules[0])))
  })

  test('the hooks module and everything it imports run without Node', () => {
    const files = [...importGraph(path.join('hooks', hooks.modules[0]))]
    assert.ok(files.length > 5)
    for (const file of files) {
      assert.doesNotMatch(read(file), /from ['"]node:|require\(|import\(/, file)
    }
  })

  test('the state contract declares every value the module keeps', () => {
    const contract = read(plugin.types)
    const module = read(path.join('hooks', hooks.modules[0]))
    for (const [, key] of module.matchAll(/\{ plugin: 'after', key: '(\w+)' \}/g)) {
      assert.match(contract, new RegExp(`\\b${key}:`), key)
    }
  })

  test('options have defaults, and the display picker offers band, status and none', () => {
    for (const [name, field] of Object.entries(plugin.userConfig)) assert.ok('default' in field, name)
    assert.deepEqual(plugin.userConfig.display.options, ['band', 'status', 'none'])
  })
})
