/**
 * lib/bili.mjs —— B 站视频搜索（匿名可用，不需要登录 / 不需要 API key）
 * ============================================================================
 * 走的是 B 站网页端自己用的那条接口：
 *   GET /x/web-interface/wbi/search/type?search_type=video&keyword=...
 * 它有 wbi 签名（w_rid / wts），还要一个 buvid3 指纹 cookie。两样都能匿名拿：
 *   ① buvid3 ← /x/frontend/finger/spi   的 data.b_3（纯 HTTP，无 cookie 也能要）
 *   ② 签名密钥 ← /x/web-interface/nav   的 data.wbi_img.{img_url,sub_url}
 *      （这个接口匿名会返回 code -101，但密钥照样给 —— 正常现象，不是错误）
 * 实测：匿名搜索 code:0，numResults 正常。搜索接口本身不要求 SESSDATA。
 * ============================================================================
 */
import crypto from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REFERER = 'https://search.bilibili.com/'

/** wbi 的字符重排表（B 站前端写死的） */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

export const ORDER_LABELS = {
  totalrank: '综合',
  click: '播放量',
  pubdate: '最新发布',
  dm: '弹幕',
}

const ORDERS = Object.keys(ORDER_LABELS)

export function normalizeOrder(value) {
  const v = String(value ?? '').trim().toLowerCase()
  return ORDERS.includes(v) ? v : 'totalrank'
}

const md5 = (text) => crypto.createHash('md5').update(text).digest('hex')
const mixinKeyOf = (raw) => MIXIN_TAB.map((index) => raw[index]).join('').slice(0, 32)

function encodeValue(value) {
  return encodeURIComponent(String(value).replace(/[!'()*]/g, ''))
}

/** 缓存 wbi 密钥 + buvid3：一小时有效，出错时自动重取一次 */
let cache = { mixin: '', cookie: '', at: 0 }
const CACHE_MS = 60 * 60 * 1000

async function getJson(url, extraHeaders = {}, signal) {
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': UA,
      Referer: REFERER,
      Origin: 'https://search.bilibili.com',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...extraHeaders,
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`B 站接口返回 HTTP ${res.status}`)
  try {
    return JSON.parse(text)
  } catch {
    // 触发风控时这里会是一整页 HTML，而不是 JSON
    throw new Error('B 站返回的不是 JSON（大概率触发了风控，稍等一会儿再试）')
  }
}

async function refreshKeys(signal) {
  const spi = await getJson('https://api.bilibili.com/x/frontend/finger/spi', {}, signal)
  const buvid3 = spi?.data?.b_3
  const buvid4 = spi?.data?.b_4

  const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', buvid3 ? { Cookie: `buvid3=${buvid3}` } : {}, signal)
  const imgUrl = nav?.data?.wbi_img?.img_url ?? ''
  const subUrl = nav?.data?.wbi_img?.sub_url ?? ''
  const imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1).split('.')[0]
  const subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1).split('.')[0]
  if (!imgKey || !subKey) throw new Error('拿不到 B 站的 wbi 签名密钥（接口结构可能变了）')

  const cookieParts = []
  if (buvid3) cookieParts.push(`buvid3=${buvid3}`)
  if (buvid4) cookieParts.push(`buvid4=${buvid4}`)

  cache = { mixin: mixinKeyOf(imgKey + subKey), cookie: cookieParts.join('; '), at: Date.now() }
  return cache
}

async function keys(signal) {
  if (cache.mixin && Date.now() - cache.at < CACHE_MS) return cache
  return refreshKeys(signal)
}

function signedQuery(params, mixin) {
  const full = { ...params, wts: String(Math.floor(Date.now() / 1000)) }
  const query = Object.keys(full)
    .sort()
    .map((key) => `${encodeValue(key)}=${encodeValue(full[key])}`)
    .join('&')
  return `${query}&w_rid=${md5(query + mixin)}`
}

const HTML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' }

function cleanTitle(raw) {
  return String(raw ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m)
    .trim()
}

/** 播放量：12345 → 1.2万 */
export function formatCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, '')}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, '')}万`
  return String(Math.round(n))
}

/** 时长：可能是 "12:34" / "3:4" / "1:02:03" / 秒数 —— 统一成 H:MM:SS 或 M:SS */
export function formatDuration(value) {
  if (typeof value === 'string' && value.includes(':')) {
    const parts = value.split(':').map((part) => Number(part))
    if (parts.every((part) => Number.isFinite(part))) {
      const total = parts.reduce((sum, part) => sum * 60 + part, 0)
      return formatDuration(total)
    }
    return value
  }
  const total = Number(value)
  if (!Number.isFinite(total) || total <= 0) return '—'
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = Math.floor(total % 60)
  const pad = (n) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

function formatDate(unixSeconds) {
  const n = Number(unixSeconds)
  if (!Number.isFinite(n) || n <= 0) return ''
  const date = new Date(n * 1000)
  const pad = (v) => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function mapItem(item) {
  const bvid = String(item?.bvid ?? '')
  // tag / typename 是搜索接口白送的分类信号：个性化匹配主要靠它们，
  // 光看标题会漏掉一大半（比如「生化危机」这个标签根本不在标题里）。
  const tags = String(item?.tag ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
  return {
    bvid,
    aid: Number(item?.aid ?? 0) || 0,
    title: cleanTitle(item?.title),
    author: String(item?.author ?? '').trim(),
    play: Number(item?.play ?? 0) || 0,
    danmaku: Number(item?.danmaku ?? item?.video_review ?? 0) || 0,
    duration: formatDuration(item?.duration),
    pubdate: formatDate(item?.pubdate),
    tname: String(item?.typename ?? '').trim(),
    tags,
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : '',
  }
}

/**
 * 搜 B 站视频。
 * @param {{keyword: string, count?: number, order?: string, signal?: AbortSignal}} options
 * @returns {Promise<{keyword: string, order: string, total: number, items: object[]}>}
 */
export async function searchBilibili({ keyword, count = 5, order = 'totalrank', signal }) {
  const word = String(keyword ?? '').trim()
  if (!word) throw new Error('关键词不能为空')
  const pageSize = Math.max(1, Math.min(Number(count) || 5, 20))
  const orderKey = normalizeOrder(order)

  const attempt = async () => {
    const keysNow = await keys(signal)
    const params = {
      search_type: 'video',
      keyword: word,
      page: '1',
      page_size: String(pageSize),
      order: orderKey,
    }
    const url = `https://api.bilibili.com/x/web-interface/wbi/search/type?${signedQuery(params, keysNow.mixin)}`
    return getJson(url, keysNow.cookie ? { Cookie: keysNow.cookie } : {}, signal)
  }

  let json
  try {
    json = await attempt()
  } catch (error) {
    if (signal?.aborted) throw error
    json = null
  }

  if (json === null || json?.code === -412 || json?.code === -352) {
    // 密钥/指纹过期或刚触发风控：换一套重新签一次再试
    cache = { mixin: '', cookie: '', at: 0 }
    json = await attempt()
  }

  if (json?.code !== 0) {
    const code = json?.code
    const message = String(json?.message ?? '').trim()
    if (code === -412 || code === -352) throw new Error('B 站搜索触发了风控（-412），过几分钟再试，或换个关键词')
    if (code === -101) throw new Error('B 站接口要求登录（-101），这台机器的匿名访问被临时限制了')
    throw new Error(`B 站搜索失败（code ${code ?? '?'}${message ? `：${message}` : ''}）`)
  }

  const list = Array.isArray(json?.data?.result) ? json.data.result : []
  const seen = new Set()
  const items = []
  for (const raw of list) {
    const item = mapItem(raw)
    if (!item.bvid || seen.has(item.bvid)) continue
    seen.add(item.bvid)
    items.push(item)
    if (items.length >= pageSize) break
  }

  return {
    keyword: word,
    order: orderKey,
    total: Number(json?.data?.numResults ?? json?.data?.numPages ?? 0) || items.length,
    items,
  }
}

/**
 * 把结果排成给人看 / 给模型读都舒服的样子。
 * @param {object} result - searchBilibili 的返回值
 * @param {{links?: 'markdown'|'plain'}} [options] -
 *   markdown：标题本身就是链接，模型转述后可直接点（工具走这条）；
 *   plain：另起一行给裸地址（命令的返回在 UI 里是纯文本 notice，渲染不了 Markdown）。
 */
export function formatResults({ keyword, order, total, items }, options = {}) {
  const links = options.links === 'plain' ? 'plain' : 'markdown'
  if (!items || items.length === 0) {
    return options.emptyText ?? `没搜到和「${keyword}」相关的视频。换个说法、少几个限定词再试。`
  }
  const label = ORDER_LABELS[order] ?? ORDER_LABELS.totalrank
  const totalText = total >= 1000 ? `${formatCount(total)}+` : formatCount(total)
  const header = options.heading
    ? options.heading(items.length)
    : `B 站搜索「${keyword}」· 按${label} · 约 ${totalText} 条结果，取前 ${items.length} 条：`
  const lines = [header, '']
  items.forEach((item, index) => {
    const meta = [
      item.author ? `UP主：${item.author}` : '',
      `播放：${formatCount(item.play)}`,
      `时长：${item.duration}`,
      order === 'pubdate' && item.pubdate ? `发布：${item.pubdate}` : '',
    ].filter(Boolean).join(' ｜ ')
    const title = links === 'markdown' ? `[${item.title}](${item.url})` : item.title
    lines.push(`${index + 1}. ${title}`)
    lines.push(`   ${meta}`)
    if (item.reasons && item.reasons.length > 0) lines.push(`   ↳ ${item.reasons.join(' · ')}`)
    if (links === 'plain') lines.push(`   ${item.url}`)
  })
  return lines.join('\n')
}
