// 相对引用的大小写检查。
//
// 为什么需要：Windows 的 NTFS 默认不区分大小写，本地 tsc 和打包都不会报错，
// 但 CI 跑在 Linux 上，`declare module '../../KPlayer'` 这种写法会因为实际
// 文件叫 `Kplayer.ts` 而静默失效——类型增强不生效，然后冒出一堆
// 「Property 'xxx' does not exist on type 'KPlayer'」的次生错误，很难倒推回去。
//
//   node scripts/check-case.mjs

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcRoot = join(repo, 'src')

const SOURCE_RE = /\.(ts|tsx|mts|cts|scss|css|html)$/
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/** 目录里每个真实条目：小写名 → 真名 */
function indexDir(dir) {
  const map = new Map()
  for (const name of readdirSync(dir)) map.set(name.toLowerCase(), name)
  return map
}

/** 逐段核对路径大小写，返回第一个不匹配的分段，或 null */
function requireExactCase(targetAbs) {
  const rel = relative(repo, targetAbs)
  if (rel.startsWith('..')) return null

  let cur = repo
  for (const part of rel.split(sep)) {
    if (!existsSync(cur)) return { want: part, got: `(父目录 ${cur} 不存在)` }
    const real = indexDir(cur).get(part.toLowerCase())
    if (real === undefined) return { want: part, got: '(不存在)' }
    if (real !== part) return { want: real, got: part }
    cur = join(cur, real)
  }
  return null
}

const files = walk(srcRoot)
const problems = []

for (const file of files) {
  if (!SOURCE_RE.test(file)) continue
  const text = readFileSync(file, 'utf8')
  const relFile = relative(repo, file)

  // import/export 的相对路径、declare module 的相对路径
  const re = /(?:from\s+|declare\s+module\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g
  let m
  while ((m = re.exec(text)) !== null) {
    const spec = m[1]
    const base = resolve(dirname(file), spec)

    let hit = null
    for (const ext of EXTS) {
      if (existsSync(base + ext)) {
        hit = base + ext
        break
      }
    }
    if (!hit) {
      problems.push(`${relFile}  ${spec}  → 找不到文件`)
      continue
    }
    const casing = requireExactCase(hit)
    if (casing) problems.push(`${relFile}  ${spec}  → 写的 '${casing.got}' 实际是 '${casing.want}'`)
  }
}

// 同一目录里仅大小写不同的重名文件，同样会让 Linux 出问题
const dups = []
for (const file of files) {
  const dir = dirname(file)
  const all = readdirSync(dir)
  for (const name of new Set(all.map((n) => n.toLowerCase()))) {
    const same = all.filter((n) => n.toLowerCase() === name)
    if (same.length > 1) dups.push(`${relative(repo, dir)}: ${same.join(' vs ')}`)
  }
}
const uniqDups = [...new Set(dups)]

console.log(`扫描 ${files.length} 个文件`)
if (problems.length === 0) {
  console.log('  \u2713 没有大小写不匹配的相对引用')
} else {
  console.log(`  \u2717 发现 ${problems.length} 处大小写不匹配：`)
  for (const p of problems) console.log(`    ${p}`)
}
if (uniqDups.length === 0) {
  console.log('  \u2713 没有仅大小写不同的同名文件')
} else {
  console.log('  \u2717 存在仅大小写不同的同名文件：')
  for (const d of uniqDups) console.log(`    ${d}`)
}

const ok = problems.length === 0 && uniqDups.length === 0
process.exit(ok ? 0 : 1)
