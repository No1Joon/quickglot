import { context, build } from 'esbuild'
import { cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')

/**
 * After `xcrun safari-web-extension-converter` has run, point QUICKGLOT_OUT at
 * the generated `.../QuickGlot Extension/Resources` directory so a rebuild is
 * picked up by the next Xcode build with no copying step.
 */
const outdir = process.env.QUICKGLOT_OUT
  ? resolve(process.env.QUICKGLOT_OUT)
  : resolve(repo, 'dist')

const options = {
  entryPoints: {
    content: resolve(repo, 'extension/src/content/index.ts'),
    background: resolve(repo, 'extension/src/background/index.ts'),
    popup: resolve(repo, 'extension/src/popup/index.ts'),
  },
  outdir,
  bundle: true,
  format: 'iife',
  target: ['safari18'],
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
}

async function copyStatic() {
  await cp(resolve(repo, 'extension/manifest.json'), resolve(outdir, 'manifest.json'))
  await cp(resolve(repo, 'extension/icons'), resolve(outdir, 'icons'), { recursive: true })
  await cp(resolve(repo, 'extension/_locales'), resolve(outdir, '_locales'), { recursive: true })
  for (const file of ['popup.html', 'popup.css']) {
    await cp(resolve(repo, 'extension', file), resolve(outdir, file))
  }
}

if (watch) {
  await mkdir(outdir, { recursive: true })
  await copyStatic()
  const ctx = await context(options)
  await ctx.watch()
  console.log(`watching -> ${outdir}`)
} else {
  // Never wipe the directory: the Xcode project holds a folder reference to it,
  // and deleting it out from under Xcode breaks the reference.
  await mkdir(outdir, { recursive: true })
  await build(options)
  await copyStatic()
  console.log(`built -> ${outdir}`)
}
