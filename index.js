/**
 * dsh-bili-search —— 输入关键词，去 B 站搜视频并给出链接
 * ============================================================================
 * 两条入口，共用一个实现（lib/bili.mjs）：
 *   ① 工具 `bilibili_search` —— 你说「帮我找 XX 视频」时模型自己调；
 *   ② 命令 `/bili 关键词`  —— 你自己敲，直接出结果，不进模型请求。
 *
 * 刻意保持「零依赖」：只用 node: 内置模块 + 全局 fetch。
 * 桌面版 profile 是 autoInstallPeers: false，裸 import 一个没装的 peer 会让
 * 整条插件静默不激活 —— 所以对 @deepseek-ai/dsh-tools 用「试试看，拿不到就
 * 用本地等价实现」的写法，绝不让一条 import 把插件带崩。
 * ============================================================================
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ORDER_LABELS, formatResults, normalizeOrder, searchBilibili } from './lib/bili.mjs'
import { defaultCookiePath, fetchNav, loadCookies, loadProfile, rerank } from './lib/personal.mjs'
import { clearProfileCache, readUserSettings, userSettingsPath, writeUserSettings } from './lib/personal.mjs'

export const name = 'bili-search'

/** 依赖的两个服务：工具注册表 + 斜杠命令注册表 */
export const inject = ['tools', 'commands']

const DEFAULTS = { count: 5, order: 'totalrank' }
const ORDER_ENUM = Object.keys(ORDER_LABELS)

/* ────────────────────────── 小日志：出问题能自证 ────────────────────────── */

const stateDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-search')

function logLine(message) {
  try {
    mkdirSync(stateDir, { recursive: true })
    appendFileSync(join(stateDir, 'plugin.log'), `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    /* 日志写不了就算了，绝不能因此让插件挂掉 */
  }
}

/* ───────────────────── dsh-tools：优先宿主那份，拿不到就自己顶上 ───────────────────── */

let hostDefineTool
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (typeof mod?.defineTool === 'function') hostDefineTool = mod.defineTool
} catch (error) {
  logLine(`dsh-tools 拿不到（${error?.code ?? error?.message ?? 'unknown'}）—— 用本地等价实现`)
}

/** 参数简写（{ required: true } 写在字段里）→ 标准 JSON Schema */
function parameterSchemaToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, field] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...rest } = field ?? {}
    const node = { ...rest }
    if (node.items && typeof node.items === 'object') node.items = convertField(node.items)
    properties[key] = node
    if (isRequired) required.push(key)
  }
  const schema = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = required
  return schema
}

function convertField(field) {
  const { required, ...rest } = field ?? {}
  const node = { ...rest }
  if (node.items && typeof node.items === 'object') node.items = convertField(node.items)
  if (node.properties) node.properties = parameterSchemaToJsonSchema(node.properties).properties
  return node
}

/**
 * 本地等价实现：只在宿主的 dsh-tools 解析不到时用。
 * 和宿主一样做 spec → JSON Schema 的转换，并保证 output 存在。
 */
function localDefineTool(options) {
  const { parameters, output, ...rest } = options
  return {
    ...rest,
    parameters: parameterSchemaToJsonSchema(parameters),
    output: output ?? { schema: { type: 'object', properties: {}, additionalProperties: true } },
  }
}

/* ────────────────────────────── 插件主体 ────────────────────────────── */

export function apply(ctx, config) {
  const settings = {
    count: clampCount(config?.count ?? DEFAULTS.count),
    order: normalizeOrder(config?.order ?? DEFAULTS.order),
    // 两个开关：关掉「工具」= 那条工具定义不再随每个请求发出去（省 token），
    // 此时只剩 /bili 命令可用。关掉「命令」则相反。两个都关 = 插件空转。
    tool: config?.tool !== false,
    command: config?.command !== false,
    // 个性化：用登录态里的观看历史 + 收藏夹给搜索结果重排
    personalize: config?.personalize !== false,
    profileCacheMinutes: clampNumber(config?.profileCacheMinutes, 30, 1, 1440),
    maxFolders: clampNumber(config?.maxFolders, 10, 1, 10),
    historyLimit: clampNumber(config?.historyLimit, 50, 10, 120),
    // 稍后再看：接口一页最多 30，0 = 不抓
    watchLater: config?.watchLater !== false,
    watchLaterLimit: clampNumber(config?.watchLaterLimit, 30, 0, 30),
    // 历史整体权重：默认 3.2（> 收藏 2 > 稍后再看 1.6）
    historyWeight: clampFloat(config?.historyWeight, 3.2, 0.1, 20),
    cookieFile: typeof config?.cookieFile === 'string' && config.cookieFile.trim()
      ? config.cookieFile.trim()
      : defaultCookiePath(),
    // 优先从内置浏览器拿登录态（不落盘、不进对话）；拿不到再用 cookieFile
    cookieFromBrowser: config?.cookieFromBrowser !== false,
  }

  // 运行时设置（/bili 设置 30），存在 <DSH_HOME>/bili-search/settings.json，优先于 profile 配置
  let userSettings = readUserSettings()
  const historyLimitFallback = settings.historyLimit

  function currentHistoryLimit() {
    return clampNumber(userSettings.historyLimit ?? historyLimitFallback, historyLimitFallback, 10, 120)
  }

  function setHistoryLimit(value) {
    userSettings = { ...userSettings, historyLimit: clampNumber(value, 50, 10, 120) }
    writeUserSettings(userSettings)
    profileMemo = null
    clearProfileCache()
    return userSettings.historyLimit
  }

  /** 只搜索，不格式化 */
  async function searchRaw(keyword, options = {}) {
    const word = String(keyword ?? '').trim()
    if (!word) throw new Error('关键词不能为空')
    const count = clampCount(options.count ?? settings.count)
    const order = normalizeOrder(options.order ?? settings.order)
    const started = Date.now()
    const result = await searchBilibili({ keyword: word, count, order, signal: options.signal })
    logLine(`搜索「${word}」order=${order} count=${count} → ${result.items.length} 条 / ${Date.now() - started}ms`)
    return result
  }

  /** 兴趣档案：内存一次，落盘另有 30 分钟 TTL（在 lib/personal.mjs 里） */
  let profileMemo = null
  let browserSession = null
  let cookieMemo = null
  let cookieAt = 0

  /** 把浏览器导出的 cookie 列表/对象转成 jar（lib/personal.mjs 的 loadCookies 同构） */
  function jarFromBrowser(cookies) {
    const pairs = []
    if (Array.isArray(cookies)) {
      for (const item of cookies) {
        if (item?.name && item?.value) pairs.push(`${item.name}=${item.value}`)
      }
    } else if (cookies && typeof cookies === 'object') {
      for (const [key, value] of Object.entries(cookies)) {
        if (typeof value === 'string') pairs.push(`${key}=${value}`)
      }
    }
    const header = pairs.join('; ')
    if (!/SESSDATA=/.test(header)) return null
    const mid = /(?:^|; )DedeUserID=([^;]+)/.exec(header)?.[1] ?? ''
    return { header, mid }
  }

  /**
   * 从内置浏览器直接取登录态（不落盘、不进对话）。
   * 拿不到就返回 null，交给 cookies.json 兜底。
   */
  async function cookieFromBrowser(signal) {
    if (Date.now() - cookieAt < 10 * 60 * 1000 && cookieMemo) return cookieMemo
    // cordis 的 ctx.get 在拿不到服务时可能抛（不同版本行为不同），别让它把整条链路带崩
    let browser
    try {
      browser = ctx.get?.('browser')
    } catch (error) {
      logLine(`取 browser 服务失败：${error?.message ?? error}`)
      return null
    }
    if (!browser || typeof browser.open !== 'function' || typeof browser.flushAuth !== 'function') return null
    try {
      if (!browserSession) {
        browserSession = await browser.open('bili-search:profile')
        await browser.navigate(browserSession, { url: 'https://www.bilibili.com/' }, signal)
      }
      const jar = jarFromBrowser(await browser.flushAuth(browserSession))
      if (jar) {
        cookieMemo = jar
        cookieAt = Date.now()
        logLine('登录态：来自内置浏览器（内存缓存 10 分钟）')
      }
      return jar
    } catch (error) {
      logLine(`从浏览器取登录态失败：${error?.message ?? error}`)
      browserSession = null
      return null
    }
  }

  async function resolveCookie(signal) {
    if (settings.cookieFromBrowser) {
      const fromBrowser = await cookieFromBrowser(signal)
      if (fromBrowser) return fromBrowser
    }
    return loadCookies(settings.cookieFile)
  }

  async function getProfile(signal) {
    if (profileMemo) return profileMemo
    const cookie = await resolveCookie(signal)
    if (!cookie) {
      throw new Error('没有登录态：先在浏览器里登录 B 站（或提供 cookies.json），个性化需要它。')
    }
    const started = Date.now()
    profileMemo = await loadProfile({
      cookie,
      signal,
      maxAgeMs: settings.profileCacheMinutes * 60 * 1000,
      maxFolders: settings.maxFolders,
      historyLimit: currentHistoryLimit(),
      watchLaterLimit: settings.watchLater ? settings.watchLaterLimit : 0,
      historyWeight: settings.historyWeight,
    })
    logLine(`档案就绪（缓存=${profileMemo.fromCache}）历史 ${profileMemo.stats.history} 条 / `
      + `收藏夹 ${profileMemo.stats.folders} 个 ${profileMemo.stats.favorites} 条 / ${Date.now() - started}ms`)
    return profileMemo
  }

  /** 搜索 + 个性化重排。个性化不可用就退回普通搜索，并在结果后注一句原因 */
  async function searchPersonal(keyword, options = {}) {
    const result = await searchRaw(keyword, options)
    const plainText = () => formatResults(result, options)
    if (!settings.personalize) return { ...result, text: plainText() }

    let profile
    try {
      profile = await getProfile(options.signal)
    } catch (error) {
      logLine(`个性化跳过：${error?.message ?? error}`)
      return { ...result, text: `${plainText()}\n\n（个性化没生效：${error.message}）` }
    }
    const items = rerank(result.items, profile).slice(0, clampCount(options.count ?? settings.count))
    const text = formatResults({ ...result, items }, options)
    // 一条都没撞上就明说，省得用户以为个性化没生效
    const matched = items.some((item) => item.reasons.length > 0)
    return { ...result, items, text: matched ? text : `${text}\n\n（这次没有一条撞上你的兴趣档案，顺序等同原始搜索）` }
  }

  /** 没有关键词时的推荐：拿档案里最硬的几个兴趣词去搜，合并、去重、排除看过的 */
  async function recommend(options = {}) {
    const count = clampCount(options.count ?? settings.count)
    const profile = await getProfile(options.signal)
    const seeds = [...profile.tags, ...profile.keywords]
      .map((entry) => entry.name)
      .filter((name, index, all) => name && name.length >= 2 && all.indexOf(name) === index)
      .slice(0, 3)
    if (seeds.length === 0) throw new Error('兴趣档案还太薄，凑不出可推荐的词（多看几个、多收藏几个再试）')

    const merged = new Map()
    for (const seed of seeds) {
      try {
        const partial = await searchBilibili({ keyword: seed, count: 20, order: 'totalrank', signal: options.signal })
        for (const item of partial.items) if (!merged.has(item.bvid)) merged.set(item.bvid, item)
      } catch (error) {
        logLine(`推荐种子「${seed}」失败：${error?.message ?? error}`)
      }
    }

    // 推荐里把「看过的」和「已经躺在稍后再看里的」都剔掉，否则等于把待办又念一遍
    const items = rerank([...merged.values()], profile)
      .filter((item) => !item.watched && !item.queued)
      .slice(0, count)
    const text = formatResults({ keyword: '', order: settings.order, total: merged.size, items }, {
      ...options,
      heading: (n) => `根据你的观看历史（${profile.stats.history} 条）与收藏夹`
        + `（${profile.stats.folders} 个 / ${profile.stats.favorites} 个视频）推荐 ${n} 条：`,
      emptyText: `按你的兴趣（${seeds.join(' / ')}）没找到还没看过的视频。`,
    })
    return { items, text, seeds }
  }

  /** /bili 状态：登录态 + 档案摘要，用来确认个性化到底有没有在跑 */
  async function statusText(signal) {
    const cookie = await resolveCookie(signal)
    if (!cookie) {
      return '未登录。\n'
        + `· 浏览器取登录态：${settings.cookieFromBrowser ? '已尝试，没拿到' : '已关闭（cookieFromBrowser: false）'}\n`
        + `· cookies.json 路径：${settings.cookieFile}\n`
        + '先去浏览器登录 B 站，再敲一次 /bili 状态。'
    }
    const nav = await fetchNav(cookie, signal)
    const profile = await getProfile(signal)
    const lines = [
      `登录账号：${nav.uname || '(未知)'}（mid ${nav.mid}）`,
      `档案：历史 ${profile.stats.history} 条 · 收藏夹 ${profile.stats.folders} 个 · 收藏视频 ${profile.stats.favorites} 条`
        + ` · 稍后再看 ${profile.stats.watchLater ?? 0} 条`
        + `　${profile.fromCache ? '（来自缓存）' : '（刚抓的）'}`,
      `常看 UP：${profile.ups.slice(0, 5).map((u) => u.name).join(' / ') || '(无)'}`,
      `高频标签：${profile.tags.slice(0, 6).map((t) => t.name).join(' / ') || '(无)'}`,
      `高频词：${profile.keywords.slice(0, 8).map((k) => k.name).join(' / ') || '(无)'}`,
      `设置：历史读最近 ${currentHistoryLimit()} 条 · 收藏夹 ${settings.maxFolders} 个`
        + ` · 稍后再看 ${settings.watchLater ? settings.watchLaterLimit : 0} 条 · 缓存 ${settings.profileCacheMinutes} 分钟`
        + `\n设置文件：${userSettingsPath()}（改法：/bili 设置 30）`,
    ]
    return lines.join('\n')
  }

  /**
   * 注册一个面。任何一步炸了都只写日志、不影响另一个面 ——
   * 「命令能用」不该被「工具注册失败」连坐。
   */
  function guard(label, fn) {
    try {
      fn()
      return true
    } catch (error) {
      logLine(`⚠️ ${label}注册失败：${error?.stack || error?.message || error}`)
      return false
    }
  }

  /* ① 工具：模型可调用 */
  const toolSpec = {
    name: 'bilibili_search',
    description: '在 B 站（bilibili）搜索视频，返回每条视频的标题、UP 主、播放量、时长和链接。'
      + '用户说「帮我找/搜一下 B 站 XX 的视频」「B 站有没有讲 XX 的」时调用。'
      + '配置了登录态时，结果会按用户的历史观看与收藏夹重排，并在每条下面给一行推荐理由。'
      + '返回的每条标题已经写成 Markdown 链接（形如 [标题](https://www.bilibili.com/video/BVxxxx)）：'
      + '原样转述即可，用户可以直接点；不要去掉方括号、不要改写或截断链接。',
    parameters: {
      keyword: { type: 'string', required: true, description: '搜索关键词，例如「原神 4.0 攻略」' },
      count: {
        type: 'number',
        description: `返回几条（1–20，默认 ${DEFAULTS.count}）`,
      },
      order: {
        type: 'string',
        enum: ORDER_ENUM,
        description: '排序：totalrank=综合（默认）/ click=播放量 / pubdate=最新发布 / dm=弹幕',
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args, exec) {
      const result = await searchPersonal(args?.keyword, {
        count: args?.count,
        order: args?.order,
        signal: exec?.signal,
        links: 'markdown',
      })
      return {
        keyword: result.keyword,
        order: result.order,
        total: result.total,
        count: result.items.length,
        items: result.items,
        text: result.text,
      }
    },
  }

  guard('bilibili_search 工具', () => {
    if (!settings.tool) {
      logLine('tool=false：不注册 bilibili_search（工具定义不进请求，只剩 /bili）')
      return
    }
    // 宿主版 defineTool 会校验参数 schema；万一它嫌这份写法不合口味，
    // 就退回本地等价实现，而不是让整条插件不激活。
    let definition
    if (hostDefineTool) {
      try {
        definition = hostDefineTool(toolSpec)
      } catch (error) {
        logLine(`宿主 defineTool 拒绝这份定义（${error?.message ?? error}），改用本地实现`)
        definition = localDefineTool(toolSpec)
      }
    } else {
      definition = localDefineTool(toolSpec)
    }
    ctx.effect(() => ctx.tools.register(definition), 'bili-search: bilibili_search 工具')
  })

  /* ② 命令：/bili 关键词 */
  guard('/bili 命令', () => {
    if (!settings.command) {
      logLine('command=false：不注册 /bili')
      return
    }
    ctx.effect(() => ctx.commands.register({
      definitionId: 'dsh-bili-search/bili',
      name: 'bili',
      description: '在 B 站搜索视频并给出链接（例：/bili 原神 攻略）',
      input: { hint: '关键词；也可以只写「状态」，留空 = 按兴趣推荐', attachments: false },
      async handler(invocation) {
        const word = String(invocation?.rawInput ?? '').trim()
        const signal = invocation?.signal
        try {
          // 空参数 = 按你的观看历史/收藏夹推荐
          if (word.length === 0) {
            const recommended = await recommend({ signal, links: 'plain' })
            return { kind: 'success', text: recommended.text }
          }
          if (word === '状态' || word.toLowerCase() === 'status') {
            return { kind: 'success', text: await statusText(signal) }
          }
          // 运行时设置：/bili 设置 [30|60|N]
          const setting = /^设置(?:\s+(\d{1,3}))?$/.exec(word)
          if (setting) {
            if (!setting[1]) {
              return {
                kind: 'success',
                text: `观看历史现在读最近 ${currentHistoryLimit()} 条。\n`
                  + `改法：/bili 设置 30 · /bili 设置 60（10–120 之间的任意整数）\n`
                  + `（保存到 ${userSettingsPath()}，改完下一次搜索按新档重建档案）`,
              }
            }
            const applied = setHistoryLimit(Number(setting[1]))
            return {
              kind: 'success',
              text: `已设为最近 ${applied} 条。\n档案缓存已清，下一次搜索会按新档重建。\n`
                + `想改回去：/bili 设置 ${historyLimitFallback}`,
            }
          }
          const { word: keyword, order } = splitOrder(word)
          // 命令的返回在 UI 里是纯文本 notice（React 转义，不渲染 Markdown），
          // 所以这里给裸地址，至少能选中复制。
          const result = await searchPersonal(keyword, { order, links: 'plain', signal })
          return { kind: 'success', text: result.text }
        } catch (error) {
          if (signal?.aborted) return { kind: 'error', text: '已取消。' }
          logLine(`/bili 失败：${error?.message ?? error}`)
          return { kind: 'error', text: `搜索失败：${error?.message ?? String(error)}` }
        }
      },
    }), 'bili-search: /bili 命令')
  })

  logLine(`插件已激活（tool=${settings.tool ? 'on' : 'off'}，command=${settings.command ? 'on' : 'off'}，`
    + `personalize=${settings.personalize ? 'on' : 'off'}，defineTool=${hostDefineTool ? 'host' : 'local'}，`
    + `cookieFile=${settings.cookieFile}，默认 count=${settings.count} order=${settings.order}）`)
  if (!settings.tool && !settings.command) {
    logLine('⚠️ tool 和 command 都关着，这个插件现在什么都不做')
  }
}

/** 命令尾部可以带排序词：/bili 原神 最新 */
const ORDER_ALIASES = {
  综合: 'totalrank',
  默认: 'totalrank',
  播放: 'click',
  播放量: 'click',
  热门: 'click',
  最新: 'pubdate',
  最新发布: 'pubdate',
  弹幕: 'dm',
}

function splitOrder(input) {
  const parts = String(input).split(/\s+/)
  if (parts.length > 1) {
    const alias = ORDER_ALIASES[parts[parts.length - 1]]
    if (alias) return { word: parts.slice(0, -1).join(' '), order: alias }
  }
  return { word: input, order: undefined }
}

function clampCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULTS.count
  return Math.max(1, Math.min(Math.round(n), 20))
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(Math.round(n), max))
}

/** 和 clampNumber 一样，但保留小数（权重是 3.2 这种） */
function clampFloat(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(n, max))
}
