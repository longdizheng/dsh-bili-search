// 个性化打分自检（不联网、不用登录）：用假数据验证档案构建与重排
// 用法：node test/personal.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProfile, loadCookies, rerank, scoreItem } from '../lib/personal.mjs'

const history = [
  { bvid: 'BV1', title: '战双帕弥什 4.5 周年剧情解析', author: '羽春雨村_', authorMid: '11', tags: ['战双帕弥什', '剧情'], tname: '游戏', viewAt: 9 },
  { bvid: 'BV2', title: '战双帕弥什 全剧情解说 上半', author: '羽春雨村_', authorMid: '11', tags: ['战双帕弥什', '剧情'], tname: '游戏', viewAt: 8 },
  { bvid: 'BV3', title: '黑神话悟空 全成就攻略 第十二期', author: '爱玩的Kaka', authorMid: '22', tags: ['黑神话悟空', '攻略'], tname: '游戏', viewAt: 7 },
  { bvid: 'BV4', title: '黑神话悟空 隐藏结局解析', author: '爱玩的Kaka', authorMid: '22', tags: ['黑神话悟空'], tname: '游戏', viewAt: 6 },
]

const folders = [
  {
    id: '101',
    title: '战双',
    count: 2,
    medias: [
      { bvid: 'BV5', title: '战双帕弥什 主线剧情合集', author: '只手书盛唐', authorMid: '33' },
      { bvid: 'BV6', title: '战双 意识海剧情梳理', author: '零壹89', authorMid: '34' },
    ],
  },
]

const watchLater = [
  { bvid: 'BV10', title: '战双帕弥什 新机体前瞻', author: '羽春雨村_', authorMid: '11', tags: [], tname: '单机游戏' },
  { bvid: 'BV11', title: '塞尔达 王国之泪 隐藏神庙', author: '某UP', authorMid: '55', tags: [], tname: '单机游戏' },
]

const profile = buildProfile(history, folders, watchLater)
console.log('档案统计:', JSON.stringify(profile.stats))
console.log('UP:', profile.ups.map((u) => `${u.name}(${u.weight})`).join(', '))
console.log('标签:', profile.tags.map((t) => `${t.name}(${t.weight})`).join(', '))
console.log('关键词:', profile.keywords.slice(0, 8).map((k) => `${k.name}(${k.weight})`).join(', '))
console.log('稍后再看 bvid:', [...profile.queued].join(','))
console.log('')

const candidates = [
  { bvid: 'BV9', title: '战双帕弥什 新版本前瞻', author: '路人UP', play: 5000 },
  { bvid: 'BV1', title: '战双帕弥什 4.5 周年剧情解析', author: '羽春雨村_', play: 900000 },
  { bvid: 'BV7', title: '原神 新角色测评', author: '另一个UP', play: 800000 },
  { bvid: 'BV8', title: '黑神话悟空 DLC 首曝', author: '爱玩的Kaka', play: 200000 },
  { bvid: 'BV10', title: '战双帕弥什 新机体前瞻', author: '羽春雨村_', play: 1000 },
]

console.log('单条打分：')
for (const item of candidates) {
  const scored = scoreItem(item, profile)
  console.log(`  ${item.title} → bonus=${scored.bonus} 理由=${scored.reasons.join(' / ') || '(无)'}`)
}

console.log('\n重排结果：')
for (const item of rerank(candidates, profile)) {
  console.log(`  ${item.bonus.toFixed(2)}  ${item.watched ? '[看过]' : '      '} ${item.title}`)
}

// 断言：感兴趣的排前面，看过的一律沉底（哪怕它兴趣分最高）
const ranked = rerank(candidates, profile)
const queuedItem = ranked.find((i) => i.bvid === 'BV10')
const assertions = [
  ['看过的那条被标记', ranked.some((i) => i.bvid === 'BV1' && i.watched)],
  ['看过的沉到最后', ranked[ranked.length - 1].bvid === 'BV1'],
  ['感兴趣的排在最前', ['BV8', 'BV9', 'BV10'].includes(ranked[0].bvid)],
  ['无关的排在看过的之前', ranked[ranked.length - 2].bvid === 'BV7'],
  ['稍后再看进了档案', profile.queued.has('BV10') && profile.queued.has('BV11')],
  ['稍后再看的条数进了 stats', profile.stats.watchLater === 2],
  ['稍后再看的视频被标出来', queuedItem?.reasons.includes('已在稍后再看') === true],
  ['稍后再看没被沉底', queuedItem?.watched === false],
]

// cookie 解析三种格式
const dir = mkdtempSync(join(tmpdir(), 'bili-cookie-'))
const asObject = join(dir, 'a.json')
writeFileSync(asObject, JSON.stringify({ sessdata: 'abc', dedeuserid: '42', buvid3: 'xyz' }), 'utf8')
const asArray = join(dir, 'b.json')
writeFileSync(asArray, JSON.stringify([{ name: 'SESSDATA', value: 'abc' }, { name: 'DedeUserID', value: '42' }]), 'utf8')
const asHeader = join(dir, 'c.txt')
writeFileSync(asHeader, 'SESSDATA=abc; DedeUserID=42; buvid3=xyz', 'utf8')

const parsed = [asObject, asArray, asHeader].map((file) => loadCookies(file))
assertions.push(['三种 cookie 格式都能解析且带 SESSDATA', parsed.every((jar) => jar && jar.header.includes('SESSDATA=abc'))])
assertions.push(['mid 能从 cookie 读出来', parsed.every((jar) => jar.mid === '42')])
assertions.push(['没有 SESSDATA 时返回 null', loadCookies(join(dir, 'missing.json')) === null])

let failed = 0
console.log('\n断言：')
for (const [label, ok] of assertions) {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`)
process.exitCode = failed === 0 ? 0 : 1
