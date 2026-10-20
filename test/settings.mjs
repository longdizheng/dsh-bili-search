// /bili 设置 的自检：用临时 DSH_HOME，不碰真实设置
// 用法：node test/settings.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'bili-settings-'))
process.env.DSH_HOME = home

const { apply } = await import(new URL('../index.js', import.meta.url).href)

const captured = {}
apply({
  effect: (fn) => fn(),
  tools: { register: (def) => { captured.tool = def; return () => {} } },
  commands: { register: (def) => { captured.command = def; return () => {} } },
  get: () => undefined,
}, { tool: true, command: true, historyLimit: 50 })

const call = (rawInput) => captured.command.handler({ rawInput, signal: new AbortController().signal })
const settingsFile = join(home, 'bili-search', 'settings.json')

let failed = 0
const check = (label, ok) => {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

console.log('设置命令自检：')
const shown = await call('设置')
check('不带参数时显示当前值 50', shown.text.includes('最近 50 条'))

const set30 = await call('设置 30')
check('设置 30 返回成功', set30.kind === 'success' && set30.text.includes('30'))

const saved = JSON.parse(readFileSync(settingsFile, 'utf8'))
check('落盘成 settings.json', saved.historyLimit === 30)

const after = await call('设置')
check('再读一次是 30', after.text.includes('最近 30 条'))

const set60 = await call('设置 60')
check('改成 60 也生效', set60.text.includes('60'))

const clamped = await call('设置 999')
check('超上限被夹到 120', clamped.text.includes('120'))

const bad = await call('设置 abc')
check('非数字不当作设置命令（会走搜索）', bad.kind === 'error' || !String(bad.text).includes('已设为'))

rmSync(home, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`)
process.exitCode = failed === 0 ? 0 : 1
