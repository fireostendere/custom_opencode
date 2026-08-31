import { execSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

try {
  const porcelain = execSync('git status --porcelain', {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()

  if (!porcelain) {
    console.log('Working tree is clean — nothing uncommitted.')
    process.exit(0)
  }

  const lines = porcelain.split('\n')
  const modified = lines.filter(l => l[0] === 'M' || l[1] === 'M')
  const untracked = lines.filter(l => l[0] === '?')
  const staged = lines.filter(l => l[0] === 'A' || l[0] === 'D' || l[0] === 'R' || l[0] === 'C')

  console.log(`Uncommitted changes: ${lines.length} file(s) total\n`)

  if (modified.length) {
    console.log(`Modified (not staged): ${modified.length}`)
    modified.forEach(l => console.log('  ' + l.slice(3)))
  }
  if (staged.length) {
    console.log(`\nStaged: ${staged.length}`)
    staged.forEach(l => console.log('  ' + l.slice(3)))
  }
  if (untracked.length) {
    console.log(`\nUntracked: ${untracked.length}`)
    untracked.forEach(l => console.log('  ' + l.slice(3)))
  }
} catch(e) {
  console.error('git failed:', e.stderr?.slice(0, 300) || e.message.slice(0, 300))
}
