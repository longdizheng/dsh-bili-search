// 命令行自测：node test/search.mjs 关键词 [条数] [排序]
// 不启动 DSH，直接验证搜索 + 格式化。
import { formatCount, formatDuration, formatResults, searchBilibili } from '../lib/bili.mjs'

const [keyword = '原神', count = '5', order = 'totalrank'] = process.argv.slice(2)

console.log('格式化自检：')
console.log('  播放量', [987, 12345, 98765432].map(formatCount).join(' / '))
console.log('  时长  ', ['3:4', '12:34', '1:02:03', 95].map(formatDuration).join(' / '))
console.log('')

const started = Date.now()
const result = await searchBilibili({ keyword, count: Number(count), order })
console.log(formatResults(result))
console.log(`\n(${result.items.length} 条 / total=${result.total} / ${Date.now() - started}ms)`)

if (result.items.length === 0) process.exitCode = 1
