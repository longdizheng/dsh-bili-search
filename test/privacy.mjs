// 隐私回归测试：确保日志里永远不会出现用户的搜索词 / UP 名 / 标题
// 用法：node test/privacy.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const sources = ['index.js', 'lib/bili.mjs', 'lib/personal.mjs'].map((rel) => ({
  rel,
  text: readFileSync(join(root, rel), 'utf8'),
}))

let failed = 0
const check = (label, ok) => {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

console.log('日志隐私自检：')

// 1. 日志语句里不允许出现「关键词」这种把用户输入拼进去的写法
const logStatements = []
for (const { rel, text } of sources) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('logLine(')) continue
    logStatements.push({ rel, line: line.trim() })
  }
}
const leaky = logStatements.filter(({ line }) => /「\$\{|`[^`]*「[^`]*」/.test(line))
check('日志语句里没有拼用户输入的「…」片段', leaky.length === 0)
if (leaky.length > 0) for (const item of leaky) console.log(`      ${item.rel}: ${item.line}`)

// 2. 搜索日志只记条数与耗时，不记词
const searchLog = logStatements.find(({ line }) => line.includes('搜索 order='))
check('搜索日志只记 order/count/条数/耗时', Boolean(searchLog))
check('搜索日志不含 word 变量', Boolean(searchLog) && !searchLog.line.includes('${word}'))

// 3. 日志有大小上限，避免无限增长
const indexText = sources.find((s) => s.rel === 'index.js').text
check('日志有 256 KB 上限', indexText.includes('LOG_MAX_BYTES') && indexText.includes('256 * 1024'))

// 4. 客户端代码里不出现作者本机的绝对路径
const absolute = sources.filter(({ text }) => /[A-Za-z]:\\\\Users\\\\|[A-Za-z]:\\\\dsh\\\\/.test(text))
check('源码里没有本机绝对路径', absolute.length === 0)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`)
process.exitCode = failed === 0 ? 0 : 1
