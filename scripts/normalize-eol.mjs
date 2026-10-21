// 把工作区文本文件的行尾统一成 LF。
//
// 为什么需要单独跑：.gitattributes 里写了 eol=lf，但已经 checkout 出来的
// 工作区文件 git 不会自动改写（索引里本来就是 LF，它认为没有变更）。
// 不统一的话，Windows 上打包会把模板里的 CRLF 一起内联进 index.user.js，
// 和 CI 产出的字节数对不上。
//
//   node scripts/normalize-eol.mjs [--dry]

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const dry = process.argv.includes('--dry')

// 只处理 git 跟踪的文本文件，让 .gitattributes 决定哪些是文本
const listing = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'buffer' })
const files = listing.toString('utf8').split('\0').filter(Boolean)

let changed = 0
let skipped = 0

for (const rel of files) {
  const full = join(repo, rel)
  let buf
  try {
    buf = readFileSync(full)
  } catch {
    skipped++ // 文件被删了之类
    continue
  }

  // 含 NUL 字节的当二进制跳过
  if (buf.includes(0)) {
    skipped++
    continue
  }

  const text = buf.toString('utf8')
  if (!text.includes('\r')) continue

  if (!dry) writeFileSync(full, text.replace(/\r\n/g, '\n'), 'utf8')
  changed++
  console.log(`  ${dry ? '将改' : '已改'} ${rel}`)
}

console.log(`\n${dry ? '需要' : '已'}统一 ${changed} 个文件的行尾，跳过 ${skipped} 个`)
