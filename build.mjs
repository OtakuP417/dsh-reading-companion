#!/usr/bin/env node
/**
 * Build both halves of the bundle.
 *
 *   lib/index.js   — the Host half: one plain ESM file, no runtime dependencies,
 *                    so a `link:` install resolves without touching node_modules.
 *   lib/client.js  — the Client half: one self-contained file wrapped in the
 *                    `__ModuleLoader__.load` factory. `react` stays external and
 *                    is taken from the factory's `require`, never bundled.
 *
 * foliate-js is vendored (see vendor/foliate-js/LICENSE, MIT) and inlined here;
 * its dynamic `import()` calls become synchronous requires because everything it
 * imports is in the same bundle.
 */

import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const lib = join(root, 'lib')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const banner = `/* ${pkg.name} v${pkg.version} — built from src/ by build.mjs; do not edit by hand. */`
const hostOut = join(lib, 'index.js')
const clientBody = join(lib, 'client.body.js')
const clientOut = join(lib, 'client.js')
const clientTmp = join(lib, 'client.js.tmp')

await mkdir(lib, { recursive: true })

// ---- Host half ---------------------------------------------------------------
await build({
  entryPoints: [join(root, 'src/index.js')],
  outfile: hostOut,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  logLevel: 'warning',
  banner: { js: banner },
})

// ---- Client half -------------------------------------------------------------
await build({
  entryPoints: [join(root, 'src/client/index.jsx')],
  outfile: clientBody,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120'],
  external: ['react'],
  inject: [join(root, 'src/client/jsx-shim.js')],
  alias: {
    'construct-style-sheets-polyfill': join(root, 'vendor/shim/construct-style-sheets-polyfill.js'),
  },
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})

const body = await readFile(clientBody, 'utf8')
const wrapped = `${banner}
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    return module.exports;
  },
});
`
await writeFile(clientTmp, wrapped, 'utf8')
await writeFile(clientOut, wrapped, 'utf8')
await rm(clientTmp, { force: true })
await rm(clientBody, { force: true })

const hostBytes = (await readFile(hostOut)).length
const clientBytes = (await readFile(clientOut)).length
console.log(`built lib/index.js (${(hostBytes / 1024).toFixed(1)} KiB) and lib/client.js (${(clientBytes / 1024).toFixed(1)} KiB)`)
