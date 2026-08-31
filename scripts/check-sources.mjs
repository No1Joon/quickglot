/**
 * Repository hygiene checks that a person cannot be relied on to remember.
 *
 * 1. A NUL byte in a text file. It is invisible in an editor, compiles fine, and
 *    silently removes the file from grep, ripgrep, and every code search — so a
 *    review reports "no matches" for a file it never opened.
 * 2. An Apple Team ID in the Xcode project. Xcode writes one in whenever signing
 *    is touched in its UI, and this repository is public and keeps that value in
 *    the QUICKGLOT_TEAM_ID environment variable instead.
 *
 * Both have happened twice here, which is why they are checked rather than
 * documented.
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

// Xcode writes DEVELOPMENT_TEAM into the project whenever signing is edited in
// its UI. The value is a personal identifier and the build takes it from the
// environment, so it must not be committed.
const projects = files.filter((f) => f.endsWith('.pbxproj'))
for (const file of projects) {
  const text = readFileSync(file, 'utf8')
  for (const [index, line] of text.split('\n').entries()) {
    const match = /DEVELOPMENT_TEAM = ([^;"\s][^;]*);/.exec(line)
    if (match) {
      problems.push(
        `${file}:${index + 1} commits an Apple Team ID (${match[1].trim()})`,
      )
    }
  }
}

// App Store Connect rejects an iOS app icon that carries an alpha channel, and
// nothing in the build says so — the upload just fails at submission time.
const iosIcon =
  'apple/QuickGlot/Shared (App)/Assets.xcassets/AppIcon.appiconset/universal-icon-1024@1x.png'
try {
  const png = readFileSync(iosIcon)
  const colourType = png[25]
  if (colourType === 6 || colourType === 4) {
    problems.push(
      `${iosIcon} has an alpha channel (colour type ${colourType}); ` +
        'App Store Connect rejects that. Run scripts/gen-icons.sh.',
    )
  }
} catch {
  // The icon is only missing in a checkout that has not been built; not a failure.
}

if (problems.length > 0) {
  console.error('Repository hygiene check failed:\n')
  for (const p of problems) console.error(`  ${p}`)
  console.error(
    '\nA NUL byte should become an escape sequence (\\u0000) if it is intentional.' +
      '\nA Team ID should be removed; pass it as QUICKGLOT_TEAM_ID at build time.',
  )
  process.exit(1)
}

console.log(
  `checked ${files.length} text files: no NUL bytes, no committed Team ID, iOS icon opaque`,
)
