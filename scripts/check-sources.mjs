/**
 * Fails when a tracked text file contains a byte that makes tools treat it as
 * binary. A stray NUL is invisible in an editor, compiles fine, and silently
 * removes the file from grep, ripgrep, and every code search — so a review or
 * an audit reports "no matches" for a file it never opened.
 *
 * This has happened twice in this repository, which is why it is checked.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

const TEXT_EXTENSIONS = new Set([
  '.ts', '.mjs', '.js', '.json', '.md', '.html', '.css', '.yml', '.yaml',
  '.swift', '.sh', '.svg', '.entitlements', '.plist', '.pbxproj',
])

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'buffer' })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .filter((f) => TEXT_EXTENSIONS.has(extname(f)))

const problems = []
for (const file of files) {
  const bytes = readFileSync(file)
  const nul = bytes.indexOf(0)
  if (nul !== -1) {
    const line = bytes.subarray(0, nul).toString('utf8').split('\n').length
    problems.push(`${file}:${line} contains a NUL byte`)
  }
}

if (problems.length > 0) {
  console.error('Source files must not contain NUL bytes:\n')
  for (const p of problems) console.error(`  ${p}`)
  console.error('\nReplace it with an escape sequence (\\u0000) if the value is intentional.')
  process.exit(1)
}

console.log(`checked ${files.length} text files, no NUL bytes`)
