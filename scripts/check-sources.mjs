/**
 * Repository hygiene checks that a person cannot be relied on to remember.
 *
 * 1. A NUL byte in a text file. It is invisible in an editor, compiles fine, and
 *    silently removes the file from grep, ripgrep, and every code search — so a
 *    review reports "no matches" for a file it never opened.
 * 2. An Apple Team ID in any tracked file. Xcode writes one into the project
 *    whenever signing is touched in its UI, and a build note in a document
 *    publishes it just as widely. This repository is public and keeps that value
 *    in the QUICKGLOT_TEAM_ID environment variable instead.
 * 3. A tracked file that .gitignore excludes. The ignore rule does nothing once
 *    the file is in the index, so the exclusion silently stops holding.
 * 4. An absolute home-directory path. It publishes the author's username and
 *    breaks on every other machine.
 *
 * All three have happened here, which is why they are checked rather than
 * documented.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

const TEXT_EXTENSIONS = new Set([
  '.ts', '.mjs', '.js', '.json', '.md', '.html', '.css', '.yml', '.yaml',
  '.swift', '.sh', '.svg', '.entitlements', '.plist', '.pbxproj',
])

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'buffer' })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)

const files = tracked.filter((f) => TEXT_EXTENSIONS.has(extname(f)))

const problems = []
for (const file of files) {
  const bytes = readFileSync(file)
  const nul = bytes.indexOf(0)
  if (nul !== -1) {
    const line = bytes.subarray(0, nul).toString('utf8').split('\n').length
    problems.push(`${file}:${line} contains a NUL byte`)
  }
}

// An Apple Team ID is ten uppercase alphanumerics with at least one of each.
// The value itself cannot be written here to compare against — that would be the
// leak — so a line is flagged when it names a team and carries a token of that
// shape, plus the App Group prefix form, which names no team at all.
const TEAM_CONTEXT = /DEVELOPMENT_TEAM|TEAM_ID|TEAMID|TEAM ID|TEAM IDENTIFIER/
const SHAPE = '(?=[0-9A-Z]{10}\\b)(?=[0-9A-Z]*[0-9])(?=[0-9A-Z]*[A-Z])[0-9A-Z]{10}'
const TEAM_ID = new RegExp(`\\b${SHAPE}\\b`)
const GROUP_PREFIX = new RegExp(`\\b${SHAPE}\\.group\\.`)

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const [index, line] of text.split('\n').entries()) {
    const grouped = GROUP_PREFIX.exec(line)
    const named = TEAM_CONTEXT.test(line.toUpperCase()) ? TEAM_ID.exec(line) : null
    const found = grouped?.[0].split('.')[0] ?? named?.[0]
    if (found) {
      problems.push(`${file}:${index + 1} commits an Apple Team ID (${found})`)
    }
  }
}

// An ignored path that is nonetheless tracked. .gitignore is advisory once a
// file is in the index — `git add -f`, or an entry added after the fact, leaves
// it committed and the ignore rule silently means nothing.
const ignoredButTracked = execFileSync(
  'git',
  ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'],
  { encoding: 'buffer' },
)
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
for (const file of ignoredButTracked) {
  problems.push(`${file} is ignored by .gitignore but tracked`)
}

// An absolute path into someone's home directory. It names the machine's user,
// and the script only runs on the machine it was written on. Paths belong
// relative to the repository, or in an environment variable.
const HOME_PATH = /(?:\/Users|\/home)\/[A-Za-z0-9._-]+\//
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const [index, line] of text.split('\n').entries()) {
    const match = HOME_PATH.exec(line)
    if (match) {
      problems.push(`${file}:${index + 1} hard-codes a home directory (${match[0]})`)
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
      '\nA Team ID should be removed; pass it as QUICKGLOT_TEAM_ID at build time.' +
      '\nAn ignored-but-tracked path needs git rm --cached.' +
      '\nA home path should become a repository-relative path or an env var.',
  )
  process.exit(1)
}

console.log(
  `checked ${files.length} text files of ${tracked.length} tracked: ` +
    'no NUL bytes, no Team ID, no home paths, nothing ignored-but-tracked, icon opaque',
)
