// 开关自检：tool / command 两个 boolean 是否真的拦住注册（不需要启动 DSH）
// 用法：node test/switches.mjs
const { apply } = await import(new URL('../index.js', import.meta.url).href)

function runWith(config) {
  const captured = { tool: null, command: null }
  const ctx = {
    effect(fn) { const out = fn(); return out },
    tools: { register(def) { captured.tool = def; return () => {} } },
    commands: { register(def) { captured.command = def; return () => {} } },
  }
  apply(ctx, config)
  return captured
}

const cases = [
  [{ tool: true, command: true }, true, true],
  [{ tool: false, command: true }, false, true],
  [{ tool: true, command: false }, true, false],
  [{ tool: false, command: false }, false, false],
  [{}, true, true], // 什么都不写 = 默认都开
]

let bad = 0
for (const [config, expectTool, expectCommand] of cases) {
  const got = runWith(config)
  const okTool = Boolean(got.tool) === expectTool
  const okCmd = Boolean(got.command) === expectCommand
  if (!okTool || !okCmd) bad++
  console.log(
    `${okTool && okCmd ? 'PASS' : 'FAIL'}  config=${JSON.stringify(config)}`,
    `tool=${Boolean(got.tool)}(期望 ${expectTool})`,
    `command=${Boolean(got.command)}(期望 ${expectCommand})`,
  )
}
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 个不符合预期`)
process.exitCode = bad === 0 ? 0 : 1
