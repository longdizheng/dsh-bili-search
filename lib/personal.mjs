/**
 * lib/personal.mjs —— 用登录态里的「观看历史 + 收藏夹」建一个兴趣档案，给搜索结果重排
 * ============================================================================
 * 数据从哪来（都要 SESSDATA，匿名拿不到）：
 *   ① /x/web-interface/history/cursor   观看历史（游标翻页）
 *   ② /x/v3/fav/folder/created/list-all 收藏夹列表
 *   ③ /x/v3/fav/resource/list           某个收藏夹里的视频
 *
 * 档案里存三类信号：
 *   · UP 主      —— 历史里出现次数 + 收藏里出现次数（收藏权重更高）
 *   · 标签/分区   —— 历史条目自带 tag_name（B 站分好的词），比从标题里硬切可靠
 *   · 关键词     —— 收藏夹名字 + 历史标题里的高频二元/三元词
 *
 * 每次调用都重新抓一遍会很容易触发风控，所以档案落盘缓存（默认 30 分钟）。
 * ============================================================================
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export function stateDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-search')
}

/* ───────────────────────── 用户设置（运行时改，不用改 profile 配置） ───────────────────────── */

export function userSettingsPath() {
  return join(stateDir(), 'settings.json')
}

export function readUserSettings() {
  try {
    const parsed = JSON.parse(readFileSync(userSettingsPath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeUserSettings(next) {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(userSettingsPath(), JSON.stringify(next, null, 2), 'utf8')
}

/** 设置变了就把档案缓存清掉，下次搜索按新参数重建 */
export function clearProfileCache() {
  try {
    rmSync(cachePath(), { force: true })
  } catch {
    /* 删不掉就算了，最多多等一个缓存周期 */
  }
}

export function defaultCookiePath() {
  return join(stateDir(), 'cookies.json')
}

function cachePath() {
  return join(stateDir(), 'profile-cache.json')
}

/* ───────────────────────────── cookie ───────────────────────────── */

/**
 * 读登录态。认三种格式：
 *   · { sessdata, bili_jct, dedeuserid, buvid3 }
 *   · [{ name, value }]（浏览器导出常见形状）
 *   · "SESSDATA=xxx; bili_jct=yyy"
 */
export function loadCookies(file = defaultCookiePath()) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const text = raw.trim()
  if (text.startsWith('{') || text.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    if (Array.isArray(parsed)) {
      const parts = parsed
        .filter((item) => item && item.name && item.value)
        .map((item) => `${item.name}=${item.value}`)
      return normalizeJar(parts.join('; '))
    }
    const map = { sessdata: 'SESSDATA', bili_jct: 'bili_jct', dedeuserid: 'DedeUserID', buvid3: 'buvid3', buvid4: 'buvid4' }
    const parts = Object.entries(map)
      .filter(([key]) => parsed[key])
      .map(([key, cookieName]) => `${cookieName}=${parsed[key]}`)
    return normalizeJar(parts.join('; '))
  }
  return normalizeJar(text)
}

function normalizeJar(header) {
  const jar = {}
  for (const pair of String(header).split(';')) {
    const index = pair.indexOf('=')
    if (index <= 0) continue
    jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim()
  }
  if (!jar.SESSDATA) return null
  return {
    header: Object.entries(jar).map(([key, value]) => `${key}=${value}`).join('; '),
    mid: jar.DedeUserID || '',
  }
}

/* ───────────────────────────── HTTP ───────────────────────────── */

async function biliJson(url, cookieHeader, signal) {
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Cookie: cookieHeader,
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`B 站接口 HTTP ${res.status}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('B 站返回的不是 JSON（大概率触发了风控）')
  }
}

/** 统一的错误翻译：这几个码在「要登录态」的接口上最常见 */
function explain(json, what) {
  const code = json?.code
  if (code === 0) return null
  if (code === -101) {
    return new Error(`没登录：${what}需要登录态（SESSDATA）。先在浏览器里登录 B 站，再刷新登录态。`)
  }
  if (code === -412 || code === -352) {
    return new Error(`风控（${code}）：${what}请求太密，过几分钟再试。`)
  }
  if (code === -400) return new Error(`${what}参数不对（-400）。`)
  return new Error(`${what}失败（code ${code ?? '?'}${json?.message ? `：${json.message}` : ''}）`)
}

/* ───────────────────────────── 抓取 ───────────────────────────── */

export async function fetchNav(cookie, signal) {
  const json = await biliJson('https://api.bilibili.com/x/web-interface/nav', cookie.header, signal)
  const error = explain(json, '登录态检查')
  if (error) throw error
  return { mid: String(json?.data?.mid ?? cookie.mid), uname: json?.data?.uname ?? '' }
}

/** 观看历史：按游标翻页，最多取 limit 条（接口一页最多 30，所以 50 = 30 + 20） */
export async function fetchHistory(cookie, { limit = 50, ps = 30, signal } = {}) {
  const items = []
  let cursor = ''
  while (items.length < limit) {
    const url = 'https://api.bilibili.com/x/web-interface/history/cursor'
      + `?ps=${ps}&type=archive&platform=web${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const json = await biliJson(url, cookie.header, signal)
    const error = explain(json, '观看历史')
    if (error) throw error
    const list = json?.data?.list ?? []
    for (const raw of list) {
      if (items.length >= limit) break
      const title = String(raw.title ?? '').trim()
      if (!title) continue
      items.push({
        bvid: String(raw.bvid ?? raw.history?.bvid ?? ''),
        title,
        author: String(raw.author_name ?? ''),
        authorMid: String(raw.author_mid ?? ''),
        tags: String(raw.tag_name ?? '')
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        tname: String(raw.tname ?? ''),
        viewAt: Number(raw.view_at ?? 0) || 0,
      })
    }
    cursor = String(json?.data?.cursor?.max ?? '')
    if (!cursor || list.length === 0) break
  }
  return items
}

/** 收藏夹：先列夹子，再挑内容最多的几个抓视频 */
export async function fetchFavorites(cookie, mid, { maxFolders = 6, perFolder = 20, signal } = {}) {
  const listUrl = `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(mid)}&web_location=333.1387`
  const listJson = await biliJson(listUrl, cookie.header, signal)
  const listError = explain(listJson, '收藏夹列表')
  if (listError) throw listError

  const folders = (listJson?.data?.list ?? [])
    .map((folder) => ({ id: String(folder.id ?? ''), title: String(folder.title ?? '').trim(), count: Number(folder.media_count ?? 0) }))
    .filter((folder) => folder.id)
    .sort((a, b) => b.count - a.count)
    .slice(0, maxFolders)

  const out = []
  for (const folder of folders) {
    const url = `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${encodeURIComponent(folder.id)}&pn=1&ps=${perFolder}&platform=web`
    let json
    try {
      json = await biliJson(url, cookie.header, signal)
    } catch {
      continue // 单个夹子抓不到就跳过，不让整份档案报销
    }
    if (json?.code !== 0) continue
    const medias = (json?.data?.medias ?? []).map((media) => ({
      bvid: String(media.bvid ?? ''),
      title: String(media.title ?? '').trim(),
      author: String(media?.upper?.name ?? ''),
      authorMid: String(media?.upper?.mid ?? ''),
      tags: [],
      tname: '',
    }))
    out.push({ id: folder.id, title: folder.title, count: folder.count, medias })
  }
  return out
}

/**
 * 稍后再看：接口一页最多 30 条，取最近 limit 条。
 * 字段比收藏少（没有 tag_name），但有 tname（分区）和 owner。
 */
export async function fetchWatchLater(cookie, { limit = 30, signal } = {}) {
  const want = Math.max(0, Math.min(Number(limit) || 0, 30))
  if (want === 0) return []
  const url = `https://api.bilibili.com/x/v2/history/toview?ps=${want}&pn=1`
  const json = await biliJson(url, cookie.header, signal)
  const error = explain(json, '稍后再看')
  if (error) throw error
  return (json?.data?.list ?? []).slice(0, want).map((raw) => ({
    bvid: String(raw.bvid ?? ''),
    title: String(raw.title ?? '').trim(),
    author: String(raw?.owner?.name ?? ''),
    authorMid: String(raw?.owner?.mid ?? ''),
    tags: [],
    tname: String(raw.tname ?? ''),
  }))
}

/* ───────────────────────────── 档案 ───────────────────────────── */

const STOPWORDS = new Set([
  // 内容形态
  '视频', '合集', '全集', '高清', '官方', '完整', '预告', '花絮', '字幕', '中字', '熟肉', '转载', '搬运',
  '更新', '解说', '攻略', '实况', '直播', '录播', 'cut', 'pv', 'op', 'ed', 'part', 'p1', 'p2',
  // 单字 / 序数
  '的', '了', '是', '在', '和', '与', '我', '你', '他', '这', '那', '第', '期', '话', '篇', '章',
  '第一', '第二', '第三', '上集', '下集', '一个', '一种', '一下',
  // 疑问 / 连接 / 语气（实测最容易污染档案的一批）
  '什么', '怎么', '为什么', '如何', '可以', '没有', '就是', '不是', '真的', '还是', '知道', '不住',
  '让你', '让我', '已经', '这个', '那个', '这么', '那么', '好的', '好好', '不好', '我是', '是我',
  '不知', '不过', '来的', '大的', '孩子', '拒绝', '你的', '是我', '永远', '你真', '角色', '住了',
  '感觉', '你就', '指挥', '挥官', '哈哈', '我们', '你们', '他们', '自己', '时候', '现在', '因为',
  '所以', '但是', '而且', '如果', '虽然', '然后', '一直', '起来', '出来', '这样', '那样', '地方',
  '东西', '事情', '问题', '干嘛', '竟然', '居然', '其实', '可能', '应该', '需要', '喜欢', '觉得',
  '看到', '听到', '说话', '说的', '看你', '给他', '给我', '跟我', '对你', '干嘛', '一下', '真的',
])

function bump(map, key, weight) {
  if (!key) return
  map.set(key, (map.get(key) ?? 0) + weight)
}

/** 中文标题里切二元/三元词（没有词典，靠频次 + 停用词过滤硬扛） */
function harvestTitleWords(title, into) {
  const cleaned = title.replace(/[【】\[\]（）()「」《》<>|/\\·:：,，.。!！?？"'“”~—\-_+*#@\s]/g, ' ').trim()
  for (const chunk of cleaned.split(/\s+/)) {
    const text = chunk.replace(/[A-Za-z0-9]+/g, (word) => (word.length >= 2 ? ` ${word} ` : ' ')).trim()
    for (const piece of text.split(/\s+/)) {
      if (!piece) continue
      if (/^[A-Za-z]{2,}$/.test(piece)) {
        const lower = piece.toLowerCase()
        if (!STOPWORDS.has(lower)) bump(into, lower, 1)
        continue
      }
      for (const size of [2, 3]) {
        for (let i = 0; i + size <= piece.length; i += 1) {
          const gram = piece.slice(i, i + size)
          if (STOPWORDS.has(gram)) continue
          bump(into, gram, size === 3 ? 0.6 : 1)
        }
      }
    }
  }
}

/** 各来源的权重。历史是「你现在真正在看什么」，默认给它最高。 */
export const WEIGHTS = Object.freeze({
  historyUp: 3.2, // 每看一次 × 新鲜度
  historyTag: 2.4, // 历史条目自带的 tag_name
  historyTname: 1.2, // 历史条目的分区
  favoriteUp: 2,
  folderName: 3, // 收藏夹名字（用户自己写的，仍是最硬的一类标签）
  watchLaterUp: 1.6,
  watchLaterTname: 0.8,
  // 历史新鲜度的下限：0.65 保证「最老的历史」也压过收藏（3.2×0.65≈2.08 > 2）
  historyRecencyFloor: 0.65,
})

/**
 * 建档案：把历史 + 收藏 + 稍后再看压成「UP / 标签 / 关键词」三张带权表。
 * 默认权重下：历史 > 收藏 > 稍后再看（收藏夹名字作为「标签」仍最强）。
 * @param {{historyWeight?:number}} [weights] -
 *   只需要调历史整体权重时给 historyWeight，标签/分区按比例跟着缩放。
 * @returns {{stats:object, ups:Array, tags:Array, keywords:Array, watched:Set<string>, queued:Set<string>}}
 */
export function buildProfile(history, folders, watchLater = [], weights = {}) {
  const ups = new Map()
  const tags = new Map()
  const words = new Map()
  const watched = new Set()
  const queued = new Set()

  // 历史整体权重可调；标签/分区按 3.2 的比例跟着缩放，保持内部比例不变
  const historyUp = Number(weights.historyWeight) > 0 ? Number(weights.historyWeight) : WEIGHTS.historyUp
  const scale = historyUp / WEIGHTS.historyUp
  // 历史要是被调低到收藏以下，新鲜度下限也要跟着降，否则「最老的历史」反而更高
  const recencyFloor = historyUp >= WEIGHTS.favoriteUp ? WEIGHTS.historyRecencyFloor : 0.35

  history.forEach((item, index) => {
    // 越近看得越重
    const recency = Math.max(recencyFloor, 1 - index / Math.max(history.length, 1))
    if (item.bvid) watched.add(item.bvid)
    bump(ups, item.author, historyUp * recency)
    for (const tag of item.tags) bump(tags, tag, WEIGHTS.historyTag * scale * recency)
    if (item.tname) bump(tags, item.tname, WEIGHTS.historyTname * scale * recency)
    harvestTitleWords(item.title, words)
  })

  for (const folder of folders) {
    // 收藏夹名字本身就是用户自己写的兴趣标签，权重给足
    if (folder.title && folder.title.length <= 12) bump(tags, folder.title, WEIGHTS.folderName)
    for (const media of folder.medias) {
      if (media.bvid) watched.add(media.bvid)
      bump(ups, media.author, WEIGHTS.favoriteUp)
      harvestTitleWords(media.title, words)
    }
  }

  // 稍后再看：想看但还没看 —— 排在收藏之下
  for (const item of watchLater) {
    if (item.bvid) queued.add(item.bvid)
    bump(ups, item.author, WEIGHTS.watchLaterUp)
    if (item.tname) bump(tags, item.tname, WEIGHTS.watchLaterTname)
    for (const tag of item.tags ?? []) bump(tags, tag, WEIGHTS.watchLaterTname)
    harvestTitleWords(item.title, words)
  }

  // 频次太低的词丢了（只出现在一条标题里的二元词基本都是噪声）。
  // 阈值分开设：UP 名字本身就是强信号，一两次就该留着；标题切出来的词要更严。
  const top = (map, limit, minWeight) => [...map.entries()]
    .filter(([key, weight]) => key && weight >= minWeight)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, weight]) => ({ name, weight: Number(weight.toFixed(2)) }))

  return {
    stats: {
      history: history.length,
      folders: folders.length,
      favorites: folders.reduce((sum, folder) => sum + folder.medias.length, 0),
      watchLater: watchLater.length,
    },
    ups: top(ups, 40, 0.8),
    tags: top(tags, 40, 1.5),
    keywords: top(words, 60, 2),
    watched,
    queued,
  }
}

/* ───────────────────────────── 打分 ───────────────────────────── */

/**
 * 给一条搜索结果打分：看它跟档案撞了多少。
 * @returns {{bonus:number, reasons:string[]}}
 */
export function scoreItem(item, profile) {
  const reasons = []
  let bonus = 0

  const up = profile.ups.find((entry) => entry.name && entry.name === item.author)
  if (up) {
    bonus += Math.min(6, 2 + up.weight / 2)
    reasons.push(`你常看 UP「${up.name}」`)
  }

  const itemTags = Array.isArray(item.tags) ? item.tags : []
  const exactTags = new Set([...itemTags, item.tname].filter(Boolean))
  const text = `${item.title} ${item.author} ${itemTags.join(' ')} ${item.tname ?? ''}`
  const matchedTags = []
  for (const tag of profile.tags) {
    if (tag.name.length < 2) continue
    // 精确命中视频标签/分区，比"标题里出现过"强得多
    const exact = exactTags.has(tag.name)
    if (!exact && !text.includes(tag.name)) continue
    matchedTags.push({ ...tag, exact })
    bonus += exact ? Math.min(3, tag.weight / 1.6) : Math.min(1.5, tag.weight / 3)
    if (matchedTags.length >= 4) break
  }
  // 只留最长的两个，避免「战双」+「战双帕弥什」这种重复理由
  const shownTags = matchedTags
    .slice()
    .sort((a, b) => (b.exact === a.exact ? b.name.length - a.name.length : b.exact ? 1 : -1))
    .filter((tag, index, all) => !all.slice(0, index).some((longer) => longer.name.includes(tag.name)))
    .slice(0, 2)
  for (const tag of shownTags) reasons.push(`${tag.exact ? '标签/分区命中' : '相关'}「${tag.name}」`)

  let wordHits = 0
  for (const word of profile.keywords) {
    if (word.name.length < 2) continue
    if (!text.includes(word.name)) continue
    wordHits += 1
    bonus += Math.min(1.5, word.weight / 6)
    if (wordHits >= 3) break
  }

  const queued = profile.queued?.has(item.bvid) ?? false
  if (profile.watched.has(item.bvid)) {
    reasons.push('已经看过')
  } else if (queued) {
    // 在稍后再看里 = 你想看但还没看，加一点分并标出来（不能沉底）
    bonus += 1
    reasons.push('已在稍后再看')
  }

  return { bonus: Number(bonus.toFixed(2)), reasons, queued }
}

/**
 * 重排：返回新数组，带上 bonus / reasons / watched 标记。
 * 分两层排：没看过的在前、看过的沉底，层内按兴趣分、再看播放量。
 * （单靠扣分不够——一条既撞 UP 又撞标签的旧视频，扣完还是能排第一。）
 */
export function rerank(items, profile) {
  return items
    .map((item) => {
      const { bonus, reasons, queued } = scoreItem(item, profile)
      return { ...item, bonus, reasons, queued, watched: profile.watched.has(item.bvid) }
    })
    .sort((a, b) => {
      if (a.watched !== b.watched) return a.watched ? 1 : -1
      return b.bonus - a.bonus || b.play - a.play
    })
}

/* ───────────────────────────── 缓存 ───────────────────────────── */

export function readCache(maxAgeMs) {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), 'utf8'))
    if (!raw?.at || Date.now() - raw.at > maxAgeMs) return null
    return {
      ...raw.profile,
      watched: new Set(raw.profile.watched ?? []),
      queued: new Set(raw.profile.queued ?? []),
    }
  } catch {
    return null
  }
}

export function writeCache(profile) {
  try {
    mkdirSync(dirname(cachePath()), { recursive: true })
    writeFileSync(cachePath(), JSON.stringify({
      at: Date.now(),
      profile: { ...profile, watched: [...profile.watched], queued: [...(profile.queued ?? [])] },
    }), 'utf8')
  } catch {
    /* 缓存写不了不影响主流程 */
  }
}

/**
 * 拿到档案：优先缓存，否则现抓。
 * @param {{cookie:object, signal?:AbortSignal, maxAgeMs?:number, maxFolders?:number, historyLimit?:number, watchLaterLimit?:number}} options
 */
export async function loadProfile({
  cookie,
  signal,
  maxAgeMs = 30 * 60 * 1000,
  maxFolders = 10,
  historyLimit = 50,
  watchLaterLimit = 30,
  historyWeight,
} = {}) {
  const cached = readCache(maxAgeMs)
  if (cached) return { ...cached, fromCache: true }

  const { mid } = await fetchNav(cookie, signal)
  const [history, folders, watchLater] = await Promise.all([
    fetchHistory(cookie, { limit: historyLimit, signal }),
    fetchFoldersSafe(cookie, mid, { maxFolders, signal }),
    watchLaterLimit > 0 ? fetchWatchLaterSafe(cookie, { limit: watchLaterLimit, signal }) : Promise.resolve([]),
  ])
  const profile = buildProfile(history, folders, watchLater, { historyWeight })
  writeCache(profile)
  return { ...profile, fromCache: false }
}

async function fetchFoldersSafe(cookie, mid, options) {
  try {
    return await fetchFavorites(cookie, mid, options)
  } catch {
    return []
  }
}

async function fetchWatchLaterSafe(cookie, options) {
  try {
    return await fetchWatchLater(cookie, options)
  } catch {
    return [] // 稍后再看抓不到不影响主流程
  }
}
