import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"

const root = new URL("../", import.meta.url)
const helperUrl = new URL("config/plugins/tui/lib/limits-helper.js", root)
const panelDataUrl = new URL("config/plugins/tui/lib/panel-data.js", root)
const panelCommandUrl = new URL("config/plugins/tui/lib/panel-command.js", root)
const dialogScrollbarUrl = new URL("config/plugins/tui/lib/dialog-scrollbar.js", root)
const panelSlash = await readFile(new URL("config/plugins/tui/panel-slash.jsx", root), "utf8")
const workspacePanel = await readFile(
  new URL("config/plugins/tui/workspace-panel.jsx", root),
  "utf8",
)
const panelViews = await readFile(new URL("config/plugins/tui/lib/panel-views.jsx", root), "utf8")
{
  const factory = panelViews.slice(
    panelViews.indexOf("export function createPanelViews(context) {"),
    panelViews.indexOf("function LimitsView()"),
  )
  for (const forbidden of ["acquireLimits(", "setInterval(", "getLimits(", "startAutoRefresh(", "readFileSync", "existsSync"]) {
    assert.ok(!factory.includes(forbidden), `Panel views must not start limits machinery at TUI start: ${forbidden}`)
  }
  const limitsView = panelViews.slice(panelViews.indexOf("function LimitsView()"), panelViews.indexOf("function TodoRows("))
  assert.match(limitsView, /acquireLimits\(\{[\s\S]*?onCleanup\(/, "LimitsView must own (acquire and release) the limits feed")
  assert.ok(limitsView.includes("geminiSeconds()"), "The Gemini countdown must be derived from the ticking clock")
  assert.ok(panelViews.includes("for (const release of limitReleases) release()"), "Disposing views must release mounted feeds")
}
const retiredPanel = await readFile(new URL("config/plugins/tui/limits-panels.jsx", root), "utf8")
const tuiPackage = JSON.parse(
  await readFile(new URL("config/plugins/tui/package.json", root), "utf8"),
)
const tuiServerEntry = await readFile(new URL("config/plugins/tui/index.js", root), "utf8")
const tuiEntry = await readFile(new URL("config/plugins/tui/tui.js", root), "utf8")
const addWizard = await readFile(new URL("config/plugins/tui/add-wizard.js", root), "utf8")
const addCommand = await readFile(new URL("config/plugins/tui/lib/add-command.js", root), "utf8")
const wslClipboard = await readFile(new URL("config/plugins/tui/wsl-clipboard.jsx", root), "utf8")
const cliConfig = JSON.parse(await readFile(new URL("config/cli.json", root), "utf8"))
assert.equal(
  cliConfig.session.scrollbar,
  true,
  "The session transcript must expose its native scrollbar",
)
assert.equal(
  cliConfig.session.sidebar,
  "auto",
  "The native context/MCP sidebar must be enabled by default",
)
assert.ok(
  !workspacePanel.includes("session.sidebar.toggle"),
  "The workspace dock must not force-hide the native context/MCP sidebar",
)
const { sessionInterruptCommand } = await import(
  new URL("config/plugins/tui/lib/session-interrupt.js", root)
)
let finishInterrupt
const interrupted = []
const interruptErrors = []
let interruptStatus = "running"
const stopCommand = sessionInterruptCommand(
  {
    data: { session: { status: () => interruptStatus } },
    client: {
      session: {
        interrupt: (input) => {
          interrupted.push(input)
          return new Promise((resolve) => {
            finishInterrupt = resolve
          })
        },
      },
    },
    ui: { toast: { show: (error) => interruptErrors.push(error) } },
  },
  () => "ses_stop",
)
assert.equal(stopCommand.enabled(), true)
const stopping = stopCommand.run()
await stopCommand.run()
assert.deepEqual(
  interrupted,
  [{ sessionID: "ses_stop", continue: false }],
  "One Escape must stop without resuming; repeated Escape must not duplicate in-flight requests",
)
finishInterrupt()
await stopping
interruptStatus = "idle"
assert.equal(stopCommand.enabled(), false)
await stopCommand.run()
assert.equal(interrupted.length, 1)
assert.deepEqual(interruptErrors, [])
assert.ok(
  workspacePanel.includes('mode: "base", priority: 120, commands: [interrupt]'),
  "Interrupt must not steal Escape from dialogs or autocomplete",
)
const envExample = await readFile(new URL(".env.example", root), "utf8")
const updater = await readFile(new URL("scripts/update.sh", root), "utf8")
const agentsPolicy = await readFile(new URL("config/prompts/engineering.md", root), "utf8")
const orchestratorPolicy = await readFile(new URL("config/prompts/orchestrator.md", root), "utf8")
const solOrchestratorPolicy = await readFile(
  new URL("config/prompts/orchestrator-sol.md", root),
  "utf8",
)
const { installDialogScrollbars } = await import(
  `${dialogScrollbarUrl.href}?contract=${Date.now()}`
)

function scrollNode(scrollSize, viewportSize) {
  return {
    optionWrites: 0,
    verticalScrollBar: { visible: false, scrollSize, viewportSize },
    set verticalScrollbarOptions(options) {
      // Like OpenTUI: the setter requests a render even for an unchanged value.
      this.optionWrites += 1
      Object.assign(this.verticalScrollBar, options)
    },
    getChildren() {
      return []
    },
  }
}
function searchNode(extra = {}) {
  return {
    placeholder: "Search",
    visible: true,
    focusable: true,
    focused: true,
    focus() {
      // Like OpenTUI: focus() is a no-op for an unfocusable renderable.
      if (this.focusable) this.focused = true
    },
    blur() {
      this.focused = false
    },
    getChildren() {
      return []
    },
    ...extra,
  }
}
function group(...children) {
  const root = { getChildren: () => children }
  for (const child of children) child.parent = root
  return root
}
let clock = 1_000
const timers = []
const fakeTimers = {
  now: () => clock,
  setTimeout(callback, delay) {
    const timer = { callback, at: clock + delay }
    timers.push(timer)
    return timer
  },
  clearTimeout(timer) {
    const index = timers.indexOf(timer)
    if (index >= 0) timers.splice(index, 1)
  },
}
function advance(ms) {
  clock += ms
  for (const timer of timers.filter((item) => item.at <= clock)) {
    timers.splice(timers.indexOf(timer), 1)
    timer.callback()
  }
}
const backgroundScroll = scrollNode(20, 10)
const backgroundSearch = searchNode()
const rootChildren = [group(backgroundScroll, backgroundSearch)]
const postProcesses = new Set()
const frame = () => {
  for (const process of postProcesses) process()
}
const dialogs = new Map()
let rootWalks = 0
const originalDialogSelect = ({ title }) => {
  const nodes =
    title === "long"
      ? [scrollNode(0, 0), searchNode()]
      : title === "filter"
        ? [scrollNode(0, 0), searchNode({ focused: false, traits: { status: "FILTER" } })]
        : [scrollNode(2, 2), searchNode()]
  // "late" dialogs mount after select() returns, like an async host render.
  if (title !== "late") rootChildren.push(group(...nodes))
  frame()
  return new Promise((resolve) => dialogs.set(title, { nodes, resolve }))
}
const dialogContext = {
  renderer: {
    root: {
      getChildren() {
        rootWalks += 1
        return rootChildren
      },
    },
    addPostProcessFn(process) {
      postProcesses.add(process)
    },
    removePostProcessFn(process) {
      postProcesses.delete(process)
    },
  },
  ui: { dialog: { select: originalDialogSelect } },
}
const removeDialogScrollbars = installDialogScrollbars(dialogContext, { interval: 120, ...fakeTimers })
const shortResult = dialogContext.ui.dialog.select({ title: "short", options: [] })
assert.equal(
  backgroundScroll.verticalScrollBar.visible,
  false,
  "Existing screen scrollbars must not be changed by a dialog",
)
assert.equal(
  backgroundSearch.visible,
  true,
  "Existing screen search inputs must not be changed by a dialog",
)
const short = dialogs.get("short")
assert.equal(short.nodes[0].verticalScrollBar.visible, false, "Short select must hide its scrollbar")
assert.equal(short.nodes[0].optionWrites, 0, "An already-hidden scrollbar must not be reassigned (render request)")
assert.equal(short.nodes[1].visible, false, "Short select must hide Search")
assert.equal(short.nodes[1].focusable, false, "Hidden Search must not stay focusable")
assert.equal(short.nodes[1].focused, false, "Hidden Search must blur")
const settledWalks = rootWalks
const lateBackgroundScroll = scrollNode(10, 2)
const lateBackgroundSearch = searchNode()
rootChildren.push(group(lateBackgroundScroll, lateBackgroundSearch))
for (let index = 0; index < 30; index += 1) {
  frame()
  advance(5)
}
advance(200)
assert.equal(rootWalks, settledWalks, "A settled dialog must never walk the whole render tree again")
assert.ok(timers.length === 0, "The trailing sync must not re-arm itself without new frames")
assert.equal(short.nodes[1].visible, false, "Unrelated overflow must not reveal short dialog Search")
assert.equal(lateBackgroundScroll.verticalScrollBar.visible, false, "Unrelated scrollbar must stay untouched")
assert.equal(lateBackgroundSearch.visible, true, "Unrelated Search must stay untouched")
assert.equal(short.nodes[0].optionWrites, 0, "Unchanged frames must not request renders")
short.resolve("short-result")
assert.equal(await shortResult, "short-result")
assert.equal(postProcesses.size, 0, "Closing must remove the frame hook")
assert.equal(timers.length, 0, "Closing must cancel a pending sync")
assert.equal(short.nodes[1].visible, true, "Closing must restore Search visibility")
assert.equal(short.nodes[1].focusable, true, "Closing must restore Search focusability")
assert.equal(short.nodes[1].focused, true, "Closing must restore Search focus state")

const longResult = dialogContext.ui.dialog.select({ title: "long", options: [] })
const long = dialogs.get("long")
assert.equal(long.nodes[1].visible, false, "Unknown 0/0 layout must initially hide Search")
long.nodes[0].verticalScrollBar.scrollSize = 3
long.nodes[0].verticalScrollBar.viewportSize = 2
frame()
assert.equal(long.nodes[0].verticalScrollBar.visible, true, "The first layout frame must reveal the scrollbar at once")
assert.equal(long.nodes[1].visible, true, "Long select must show Search")
assert.equal(long.nodes[1].focusable, true, "Shown Search must restore focusability")
assert.equal(long.nodes[1].focused, true, "Shown Search must restore focus state")
const longWrites = long.nodes[0].optionWrites
const longWalks = rootWalks
for (let index = 0; index < 20; index += 1) {
  frame()
  advance(40)
}
advance(200)
assert.equal(long.nodes[0].optionWrites, longWrites, "Unchanged syncs must not reassign scrollbar options")
assert.equal(rootWalks, longWalks, "Frames of a settled dialog must only visit the dialog subtree")
advance(500)
long.nodes[1].value = "x"
long.nodes[0].verticalScrollBar.scrollSize = 2
frame()
assert.equal(long.nodes[0].verticalScrollBar.visible, false, "A due frame must sync immediately")
assert.equal(long.nodes[1].visible, true, "Active filter must keep Search visible")
assert.equal(long.nodes[1].focusable, true, "Active filter must keep Search focusable")
long.nodes[1].value = ""
long.nodes[0].verticalScrollBar.scrollSize = 5
frame()
assert.equal(long.nodes[0].verticalScrollBar.visible, false, "Frames inside the throttle window must not sync")
assert.equal(timers.length, 1, "A throttled frame must schedule one trailing sync")
frame()
assert.equal(timers.length, 1, "Throttled frames must share one trailing sync")
advance(120)
assert.equal(long.nodes[0].verticalScrollBar.visible, true, "The trailing sync must apply the latest layout")
long.nodes[0].verticalScrollBar.scrollSize = 2
advance(500)
frame()
assert.equal(long.nodes[1].visible, false, "Empty filtered non-overflow select must hide Search")
long.resolve("long-result")
assert.equal(await longResult, "long-result")
assert.equal(
  long.nodes[0].verticalScrollBar.visible,
  false,
  "Dialog scrollbar override must be released on close",
)

// Native DialogSelect focuses its filter one tick after mounting. The first
// sync hides Search before that tick (unknown layout), so the native focus()
// is a no-op; revealing the filter must focus it or typing goes nowhere.
const filterResult = dialogContext.ui.dialog.select({ title: "filter", options: [] })
const filter = dialogs.get("filter")
assert.equal(filter.nodes[1].visible, false)
filter.nodes[1].focus()
assert.equal(filter.nodes[1].focused, false, "Hidden Search must refuse the native mount focus")
filter.nodes[0].verticalScrollBar.scrollSize = 30
filter.nodes[0].verticalScrollBar.viewportSize = 10
frame()
assert.equal(filter.nodes[1].visible, true)
assert.equal(filter.nodes[1].focused, true, "A revealed native filter must receive focus so typing filters")
filter.resolve(undefined)
await filterResult

const lateResult = dialogContext.ui.dialog.select({ title: "late", options: [] })
const late = dialogs.get("late")
rootChildren.push(group(...late.nodes))
late.nodes[0].verticalScrollBar.scrollSize = 9
late.nodes[0].verticalScrollBar.viewportSize = 3
frame()
assert.equal(late.nodes[0].verticalScrollBar.visible, true, "A dialog mounted after select() must be discovered")
assert.equal(late.nodes[1].visible, true)
late.resolve(null)
await lateResult

removeDialogScrollbars()
assert.equal(
  dialogContext.ui.dialog.select,
  originalDialogSelect,
  "Dialog select wrapper must be removable",
)
const dialogScrollbarSource = await readFile(dialogScrollbarUrl, "utf8")
assert.ok(
  !/addPostProcessFn\?\.\(sync\)/.test(dialogScrollbarSource),
  "The full sync must not run as an unthrottled per-frame hook",
)

async function runtimeSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const sources = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) sources.push(...(await runtimeSources(path)))
    else if (/\.[jt]sx?$/.test(entry.name)) sources.push(path)
  }
  return sources
}

const rootPath = fileURLToPath(root)
const tuiSourceRoot = join(rootPath, "config", "plugins", "tui")
for (const path of await runtimeSources(tuiSourceRoot)) {
  const source = await readFile(path, "utf8")
  const file = relative(rootPath, path)
  for (const [name, pattern] of [
    ["direct theme.hue access", /(?:\bcontext\.)?theme\.hue\b/],
    ["hex color literal", /#[0-9a-f]{3,8}\b/i],
    ["rgb()/rgba()/hsl()/hsla() color function", /\b(?:rgba?|hsla?)\s*\(/i],
    ["ANSI escape literal", /\\x1b|\\u001b|\x1b/i],
  ]) {
    assert.doesNotMatch(source, pattern, `${file}: runtime source must not contain ${name}`)
  }
}

function themePathValue(theme, path) {
  return path.split(".").reduce((value, segment) => value?.[segment], theme)
}

const themePaths = [
  "text.formfield.$selected",
  "text.status.running",
  "text.action.secondary.default",
]
const themesRoot = join(rootPath, "config", "themes")
for (const entry of await readdir(themesRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".json")) continue
  const path = join(themesRoot, entry.name)
  const theme = JSON.parse(await readFile(path, "utf8"))
  for (const mode of ["dark", "light"]) {
    for (const themePath of themePaths) {
      assert.equal(
        typeof themePathValue(theme[mode], themePath),
        "string",
        `${relative(rootPath, path)}: ${mode}.${themePath} must be a string`,
      )
    }
  }
}

assert.equal(cliConfig.keybinds["prompt.history.previous"], "up")
assert.equal(cliConfig.keybinds["prompt.history.next"], "down")
assert.equal(cliConfig.keybinds["app.exit"], "ctrl+shift+q")
assert.equal(cliConfig.session.thinking, "hide", "TUI reasoning must stay out of the conversation")
assert.equal(
  cliConfig.session.grouping,
  "auto",
  "TUI tool calls must stay grouped as one compact execution status",
)
assert.equal(cliConfig.mouse, true, "TUI mouse support must stay enabled for clickable controls")
assert.equal(
  tuiPackage.exports["./tui"],
  "./tui.js",
  "TUI package must expose the V2 ./tui entrypoint",
)
assert.equal(
  tuiPackage.exports["."],
  "./index.js",
  "TUI package must expose a valid server entrypoint",
)
assert.match(tuiServerEntry, /id: "custom\.tui-bundle"/)
assert.ok(
  tuiEntry.includes("installDialogScrollbars(context)"),
  "TUI bundle must install select-dialog scrollbars",
)
// Bundle isolation: a throwing sub-plugin setup must not abort the others or
// leak their patches; a throwing cleanup must not skip the remaining ones.
{
  const events = []
  const fakes = {}
  const fakePlugin = (id, behavior = {}) => ({
    id,
    setup() {
      events.push(`setup ${id}`)
      if (behavior.setupThrows) throw new Error(`${id} setup broke`)
      return () => {
        events.push(`cleanup ${id}`)
        if (behavior.cleanupThrows) throw new Error(`${id} cleanup broke`)
      }
    },
  })
  let bundleSource = tuiEntry.replace(
    'import { Plugin } from "@opencode-ai/plugin/tui"',
    "const Plugin = { define(value) { return value } }",
  )
  bundleSource = bundleSource.replace(/^import (\w+) from "\.\/([^"]+)"$/gm, (_, name, file) => {
    fakes[file] = fakePlugin(file, {
      setupThrows: file === "add-wizard.js",
      cleanupThrows: file === "panel-slash.jsx",
    })
    return `const ${name} = globalThis.__tuiBundleFakes[${JSON.stringify(file)}]`
  })
  bundleSource = bundleSource.replace(/^import \{ (\w+) \} from "\.\/lib\/[^"]+"$/gm, (_, name) => {
    fakes[name] = (context) => {
      events.push(`setup ${name}`)
      return () => events.push(`cleanup ${name}`)
    }
    return `const ${name} = globalThis.__tuiBundleFakes[${JSON.stringify(name)}]`
  })
  assert.ok(!/^import /m.test(bundleSource), "every bundle import must be faked")
  globalThis.__tuiBundleFakes = fakes
  const bundle = (await import(`data:text/javascript;base64,${Buffer.from(bundleSource).toString("base64")}`)).default
  const toasts = []
  const logged = []
  const originalError = console.error
  console.error = (...args) => logged.push(args.join(" "))
  let cleanup
  try {
    cleanup = bundle.setup({ ui: { toast: { show: (value) => toasts.push(value) } } })
    assert.equal(typeof cleanup, "function")
    assert.ok(events.includes("setup wsl-clipboard.jsx"), "Plugins after a failing setup must still load")
    assert.equal(toasts.length, 1)
    assert.match(toasts[0].message, /add-wizard\.js failed to load/)
    cleanup()
    cleanup()
  } finally {
    console.error = originalError
    delete globalThis.__tuiBundleFakes
  }
  const cleanups = events.filter((item) => item.startsWith("cleanup "))
  assert.deepEqual(
    cleanups,
    [
      "cleanup wsl-clipboard.jsx",
      "cleanup workspace-panel.jsx",
      "cleanup limits-panels.jsx",
      "cleanup panel-slash.jsx",
      "cleanup model-selector.jsx",
      "cleanup server-wizard.js",
      "cleanup webserver-wizard.js",
      "cleanup effort-indicator.jsx",
      "cleanup location-recovery.jsx",
      "cleanup installCompactionRecovery",
      "cleanup installDialogScrollbars",
    ],
    "Every successful setup must be unwound once, in reverse order, despite a throwing cleanup",
  )
  assert.equal(logged.length, 2, "Each failure is logged once")
}
for (const source of [
  "add-wizard.js",
  "effort-indicator.jsx",
  "location-recovery.jsx",
  "model-selector.jsx",
  "panel-slash.jsx",
  "limits-panels.jsx",
  "workspace-panel.jsx",
  "wsl-clipboard.jsx",
]) {
  assert.ok(tuiEntry.includes(`./${source}`), `TUI bundle must include ${source}`)
}
for (const marker of [
  'id: "custom.add-wizard"',
  "installPanelSubmitRouter",
  "currentFocusedRenderable",
  "context.ui.dialog.prompt",
  "context.ui.dialog.select",
  "context.client.session.command",
  "custom.add-wizard.add",
  "custom.add-wizard.${kind}",
]) {
  assert.ok(addWizard.includes(marker), `TUI add wizard marker missing: ${marker}`)
}
for (const marker of [
  "export const ADD_KINDS",
  "parseAddCommand",
  "addprovider",
  "addmodel",
  "addmcp",
  "addskill",
  "addorchestration",
]) {
  assert.ok(addCommand.includes(marker), `TUI add parser marker missing: ${marker}`)
}
for (const marker of [
  'id: "custom.wsl-clipboard"',
  "processPaste",
  'bind: "ctrl+v"',
  'prependListener?.("paste"',
  "powershell.exe",
]) {
  const source =
    marker === "powershell.exe"
      ? await readFile(new URL("config/plugins/tui/lib/wsl-clipboard.js", root), "utf8")
      : wslClipboard
  assert.ok(source.includes(marker), `WSL clipboard bridge marker missing: ${marker}`)
}
for (const forbidden of ["FilePart", "imageAttachment", 'prependListener("keypress"']) {
  assert.ok(!wslClipboard.includes(forbidden), `WSL clipboard bridge must not use ${forbidden}`)
}
assert.match(envExample, /^OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT=1$/m)
assert.ok(
  updater.includes("^OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT=") &&
    updater.includes("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT=1"),
  "Updater must migrate existing .env files to explicit Ctrl+C copy mode",
)

assert.ok(
  !tuiEntry.includes("prompt-history"),
  "TUI must use supported native prompt history bindings",
)

for (const marker of [
  'id: "custom.panel-slash"',
  "slash: { name: slashName }",
  "panel left",
  "panel right",
  "panel top",
  "panel bottom",
  "panel reset",
  "panel ${side} off",
  "panel ${side} pin",
  "panel ${side} unpin",
  "panel ${side} collapse",
  "panel ${side} expand",
  "panel ${side} ${view}",
  "context.keymap.dispatch(target)",
]) {
  assert.ok(panelSlash.includes(marker), `Native panel slash marker missing: ${marker}`)
}
assert.ok(
  !panelSlash.includes('bind: "enter"'),
  "Native /panel commands must never override prompt Enter",
)
assert.ok(
  !panelSlash.includes("context.ui.Prompt"),
  "Native /panel commands must not touch prompt submission",
)
assert.ok(
  !panelSlash.includes("context.client"),
  "Native /panel commands must not call model/client APIs",
)
assert.ok(
  !panelSlash.includes("context.keymap.dispatchCommand"),
  "Native /panel commands must use the official keymap dispatch API",
)
assert.ok(
  !workspacePanel.includes("context.keymap.dispatchCommand"),
  "Workspace panel must use the official keymap dispatch API",
)

for (const marker of [
  'id: "custom.workspace-panel"',
  "workspace-panel.state",
  "version: 3",
  "universal-panel.state",
  "migratedUniversalV1",
  "function freshZones()",
  "left:",
  "right:",
  "top:",
  "bottom:",
  "function Zone(props)",
  "function configurePanels()",
  "context.ui.DialogSelect",
  'slash: { name: "panel" }',
  "custom.panels.configure",
  "PANEL_SIDES",
  "PANEL_VIEWS",
  "scrollPositions",
  "verticalScrollbarOptions",
  "scrollY={true}",
  "stickyScroll={true}",
  'stickyStart="bottom"',
  "scrollTop",
  "atBottom: top >= max",
  "if (!saved || saved.atBottom) scrollToEnd(scroll)",
  "scrollTo(Number.MAX_SAFE_INTEGER)",
  "target.paddingLeft",
  "target.paddingRight",
  "target.paddingTop",
  "target.paddingBottom",
  "theme.text.formfield.$selected",
  "theme.text.action.secondary.default",
  "theme.border.default",
  "theme.scrollbar.default",
  "theme.background.surface.offset",
  'const PIN_ICON = "📌"',
  "theme.background.action.primary.default",
  "theme.text.action.primary.default",
  "jumpToEnd",
  "cursorUnderOverlay",
  "addPostProcessFn",
  "custom.panel.toggle",
  "custom.panel.activity",
  "custom.panel.plan",
  "custom.panel.limits",
  "custom.panel.end",
]) {
  assert.ok(workspacePanel.includes(marker), `Four-zone workspace dock marker missing: ${marker}`)
}
assert.ok(
  !workspacePanel.includes("scrollTo({ y: Number.MAX_SAFE_INTEGER })"),
  "Jump-to-end must use the numeric ScrollBox vertical position API",
)
assert.ok(
  !workspacePanel.includes("node?.scrollToBottom"),
  "ScrollBox must use its documented scrollTo API",
)
assert.ok(
  !workspacePanel.includes("node?.scrollToEnd"),
  "ScrollBox must use its documented scrollTo API",
)
assert.ok(
  !workspacePanel.includes("scrollPositions.get(key) ?? 0"),
  "A new session/view must not override stickyStart by scrolling to the top",
)
assert.ok(
  workspacePanel.includes('side === "right" && x >= width - size'),
  "Right overlays must hide the cursor starting at their first occupied cell",
)
assert.ok(
  workspacePanel.includes('side === "bottom" && y >= height - size'),
  "Bottom overlays must hide the cursor starting at their first occupied cell",
)
assert.ok(
  !workspacePanel.includes(
    '<Show when={props.side === "right"}>\n                  <box width={HANDLE} flexShrink={0} />',
  ),
  "The right panel must not waste a cell before its scrollbox",
)
assert.match(
  workspacePanel,
  /<scrollbox[\s\S]*?flexGrow=\{1\}[\s\S]*?minWidth=\{0\}/,
  "Panel scrollboxes must allow horizontal shrink",
)
assert.match(
  workspacePanel,
  /<box flexDirection="column" width="100%" minWidth=\{0\} paddingX=\{1\} paddingTop=\{1\} paddingBottom=\{1\}/,
  "Panel scroll content must fill and shrink within the viewport",
)
assert.ok(
  !workspacePanel.includes("live updates keep scroll"),
  "The obsolete scroll-status label must be removed",
)
assert.ok(
  !workspacePanel.includes(
    "<box onMouseDown={() => setCollapsed(props.side, true)}><text fg={theme.text.subdued}><span>{COLLAPSE_ICON[props.side]}</span></text></box>",
  ),
  "Collapse must not remain in the header",
)
assert.match(workspacePanel, /const HANDLE = 1\b/, "Panel handles must occupy one terminal cell")
assert.ok(
  workspacePanel.includes("border={item().collapsed ? false :"),
  "Collapsed one-cell handles must not lose their icon behind a border",
)
assert.ok(workspacePanel.includes("function ExpandedHandle(props)"), "ExpandedHandle must exist")
assert.match(
  workspacePanel,
  /<box flexDirection="column" flexShrink=\{0\} paddingX=\{1\} paddingTop=\{1\} gap=\{1\}>[\s\S]*?<\/box>[\s\S]*?<ExpandedHandle side=\{props\.side\} \/>/,
  "ExpandedHandle must render separately from the header",
)
assert.ok(
  workspacePanel.includes('const atStart = props.side === "right" || props.side === "bottom"'),
  "ExpandedHandle must derive the internal edge from atStart",
)
assert.ok(
  workspacePanel.includes('[atStart ? "left" : "right"]'),
  "ExpandedHandle internal edge must map right to left and left to right",
)
assert.ok(
  workspacePanel.includes('[atStart ? "top" : "bottom"]'),
  "ExpandedHandle internal edge must map bottom to top and top to bottom",
)
assert.doesNotMatch(
  workspacePanel,
  /padding(?:Left|Right|Top|Bottom)=\{props\.side === "(?:left|right|top|bottom)" && !item\(\)\.collapsed \? HANDLE : 0\}/,
  "Expanded panels must not reserve handle space with outer padding",
)
assert.ok(
  !workspacePanel.includes("context.ui.dialog.select("),
  "Configurator must use the current DialogSelect component API",
)
assert.ok(
  !workspacePanel.includes("function EdgePanel("),
  "Legacy independent EdgePanel abstraction must stay removed",
)
assert.ok(!workspacePanel.includes("planPinned"), "Feature view must not own a plan pin")
assert.ok(!workspacePanel.includes("homePinned"), "Feature view must not own a limits pin")
assert.ok(
  !workspacePanel.includes("theme.hue?.orange"),
  "Workspace panel must not use a fixed orange accent",
)
assert.ok(
  !panelViews.includes("theme.hue?.orange"),
  "Panel views must not use a fixed orange accent",
)
assert.ok(
  !workspacePanel.includes("function accent("),
  "Workspace panel must not retain the accent helper",
)
assert.ok(!panelViews.includes("function accent("), "Panel views must not retain the accent helper")
assert.match(
  workspacePanel,
  /fg=\{active\(\) \? theme\.text\.formfield\.\$selected : theme\.text\.subdued\}/,
  "Active tabs must use the selected form-field token",
)
assert.match(
  workspacePanel,
  /<text fg=\{theme\.text\.action\.secondary\.default\}><span>↓ конец<\/span><\/text>/,
  "Jump-to-end must use the secondary action token",
)
assert.doesNotMatch(
  workspacePanel,
  /setPinned\(props\.side, !item\(\)\.pinned\)[\s\S]{0,250}theme\.text\.feedback\.error\.default/,
  "Pin control must not use an error color",
)
assert.match(
  workspacePanel,
  /let disposed = false[\s\S]*?function syncDockLayout\(\) \{\s*if \(disposed\) return/,
  "Dock sync must no-op after disposal",
)
assert.match(
  workspacePanel,
  /function scheduleDockLayout\(\) \{\s*if \(disposed \|\| dockScheduled\) return/,
  "Dock scheduling must no-op after disposal",
)
assert.match(
  workspacePanel,
  /queueMicrotask\(\(\) => \{\s*if \(!disposed\) syncDockLayout\(\)/,
  "Queued dock layout must check disposal",
)
assert.match(
  workspacePanel,
  /return \(\) => \{\s*disposed = true\s*if \(dockRetry\) clearTimeout\(dockRetry\)\s*restoreDockTarget\(\)/,
  "Dock cleanup must mark disposed before cancelling retries and restoring layout",
)

for (const marker of [
  "export const PANEL_DEFS",
  '{ id: "activity"',
  "createPanelViews",
  "function ActivityView",
  "function PlanView",
  "function OrchestrationView",
  "function HistoryView",
  "function SessionView",
  "function LimitsView",
]) {
  assert.ok(panelViews.includes(marker), `Panel view registry marker missing: ${marker}`)
}
assert.ok(!panelViews.includes("target.padding"), "Feature views must never mutate root layout")
assert.ok(!panelViews.includes("<scrollbox"), "Only the dock host may own panel scrollboxes")
assert.match(
  panelViews,
  /function WindowRows\(props\)[\s\S]*?<box flexDirection="column" width="100%" minWidth=\{0\} flexShrink=\{0\}>/,
  "Limit windows must fit narrow panels",
)
assert.match(
  panelViews,
  /function LimitsView\(\)[\s\S]*?<box flexDirection="column" width="100%" minWidth=\{0\} gap=\{1\} flexShrink=\{0\}>/,
  "Limits view must fit narrow panels",
)
assert.equal(
  (panelViews.match(/theme\.text\.status\.running/g) ?? []).length,
  3,
  "Panel views must use the running status token only for active work",
)
assert.match(
  panelViews,
  /active \? theme\.text\.status\.running : done \? theme\.text\.feedback\.success\.default/,
  "Active todo markers must use the running status token",
)
assert.match(
  panelViews,
  /const running = current\.todos\.some\(\(todo\) => todo\.status === "in_progress"\)/,
  "Plan progress must detect in-progress todos",
)
assert.match(
  panelViews,
  /completed === current\.todos\.length \? theme\.text\.feedback\.success\.default : running \? theme\.text\.status\.running : theme\.text\.default/,
  "Plan progress must distinguish completed, running, and pending states",
)
assert.match(
  panelViews,
  /row\.role === "assistant" \? theme\.text\.default : theme\.text\.subdued/,
  "Assistant activity roles must use the default text token",
)
assert.match(
  panelViews,
  /row\.status === "running" \|\| row\.status === "in_progress" \? theme\.text\.status\.running : theme\.text\.default/,
  "Only active orchestration statuses must use the running status token",
)
assert.ok(
  !panelViews.includes("taskLike:"),
  "Task-like orchestration names must not determine color",
)
for (const marker of [
  "createEffect(() => {",
  "setHistoricalTodos(null)",
  "current && props.sessionID === sessionID",
  "if (found !== null)",
  "function useSessionMessageSync(props)",
  "useSessionMessageSync(props)",
  "context.data.session.root(sessionID)",
  "context.data.session.family(rootID)",
  "context.data.session.sync(rootID)",
  "normalizeFamilyIDs(rootID, family)",
  "context.data.session.message.sync(sessionID)",
  "syncFamilyMessages(ids, (id) => context.data.session.message.sync(id))",
  "readV2Plan(sessionID)",
  "selectV2PlanEntries(entries, sessionID)",
  "selectV2PlanCandidates(candidates, sessionID)",
  "const V2_PLAN_MAX_BYTES = 1_000_000",
  "if (details.size > V2_PLAN_MAX_BYTES) continue",
  "message.updated",
  "message.part.updated",
  "session.message.content.updated",
  "session.created",
  "session.updated",
  "session.deleted",
]) {
  assert.ok(panelViews.includes(marker), `Plan/session/family marker missing: ${marker}`)
}
assert.ok(
  !panelViews.includes("context.client.session.list"),
  "Orchestration must not enumerate global sessions",
)
assert.ok(
  !panelViews.includes("const children = new Map()"),
  "Orchestration must not reconstruct session families manually",
)
assert.equal(
  (panelViews.match(/^    useSessionMessageSync\(props\)$/gm) ?? []).length,
  4,
  "Plan, Session, Activity, and History must each request initial message sync",
)

const panelData = await import(`${panelDataUrl.href}?fixtures=${Date.now()}`)
const nativeDocument = {
  todos: [{ content: "native plan", status: "pending" }],
  source: "native-v2",
}
assert.deepEqual(
  panelData.resolvePlanSources(
    [],
    [{ content: "historical", status: "completed" }],
    nativeDocument,
  ),
  {
    todos: [],
    source: "session-todo",
    document: null,
  },
  "cached empty todo list must suppress historical and native documents",
)
assert.deepEqual(
  panelData.resolvePlanSources(null, [], nativeDocument),
  {
    todos: [],
    source: "session-todo",
    document: null,
  },
  "historical empty todo list must suppress native documents",
)
const cachedTodos = [{ content: "cached", status: "in_progress" }]
assert.deepEqual(
  panelData.resolvePlanSources(
    cachedTodos,
    [{ content: "historical", status: "completed" }],
    nativeDocument,
  ),
  {
    todos: cachedTodos,
    source: "session-todo",
    document: null,
  },
  "cached todos must win",
)
const historicalTodos = [{ content: "historical", status: "completed" }]
assert.deepEqual(
  panelData.resolvePlanSources(null, historicalTodos, nativeDocument),
  {
    todos: historicalTodos,
    source: "session-todo",
    document: null,
  },
  "historical todos must win when cache has no signal",
)
assert.deepEqual(
  panelData.resolvePlanSources(null, null, nativeDocument),
  {
    todos: nativeDocument.todos,
    source: "native-v2",
    document: nativeDocument,
  },
  "native V2 document must be a fallback in an active session",
)
assert.equal(panelData.resolveRootID("child", { id: "root" }), "root")
assert.deepEqual(
  panelData.normalizeFamilyIDs("root", [
    { id: "child" },
    { id: "root" },
    "child",
    { sessionID: "grandchild" },
  ]),
  ["root", "child", "grandchild"],
  "family IDs must include root and remove duplicates",
)
assert.deepEqual(
  panelData.normalizeFamilyIDs("root", [{ id: "child-a" }, { id: "child-b" }]),
  ["root", "child-a", "child-b"],
  "family normalization must not introduce IDs outside the supplied family",
)

const planEntries = [
  { name: "active-plan.md", isFile: () => true },
  { name: "foreign-plan.md", isFile: () => true },
  { name: "latest-plan.md", isFile: () => true },
  { name: "active.txt", isFile: () => true },
  { name: "directory-plan.md", isFile: () => false },
]
assert.deepEqual(
  panelData.selectV2PlanEntries(planEntries, "active").map((entry) => entry.name),
  ["active-plan.md"],
  "an active session must select only its exact native V2 plan filename",
)
assert.deepEqual(
  panelData
    .selectV2PlanCandidates(
      [
        { name: "foreign-plan.md", updated: 300 },
        { name: "latest-plan.md", updated: 200 },
        { name: "active-plan.md", updated: 100 },
      ],
      "active",
    )
    .map((entry) => entry.name),
  ["active-plan.md"],
  "an active session must not select a foreign or newer native plan document",
)
assert.deepEqual(
  panelData
    .selectV2PlanCandidates(
      [
        { name: "older-plan.md", updated: 100 },
        { name: "latest-plan.md", updated: 300 },
      ],
      null,
    )
    .map((entry) => entry.name),
  ["latest-plan.md", "older-plan.md"],
  "home native plan selection must retain latest-document ordering",
)
const positions = new Map()
for (let index = 0; index < 150; index += 1) panelData.rememberBounded(positions, `right:ses_${index}:plan`, { top: index }, 100)
assert.equal(positions.size, 100, "Scroll positions must stay bounded")
assert.equal(positions.has("right:ses_49:plan"), false, "The least recently saved position must be evicted")
panelData.rememberBounded(positions, "right:ses_50:plan", { top: 1 }, 100)
panelData.rememberBounded(positions, "right:ses_new:plan", { top: 2 }, 100)
assert.equal(positions.has("right:ses_50:plan"), true, "A re-saved position must become most recent")
assert.equal(positions.has("right:ses_51:plan"), false)
assert.match(
  workspacePanel,
  /rememberBounded\(scrollPositions, key, \{ top, atBottom: top >= max \}, SCROLL_POSITION_LIMIT\)/,
  "Workspace panel must bound its per-session scroll positions",
)
const syncedIDs = []
await panelData.syncFamilyMessages(["throws", "after"], (id) => {
  syncedIDs.push(id)
  if (id === "throws") throw new Error("synchronous sync failure")
})
assert.deepEqual(
  syncedIDs,
  ["throws", "after"],
  "one synchronous family message sync failure must not prevent other syncs",
)

for (const [name, policy] of [
  ["Qwen", orchestratorPolicy],
  ["SOL", solOrchestratorPolicy],
]) {
  for (const marker of [
    "plan_update",
    "1-7",
    "chain-of-thought",
    "meaningful milestones",
    "Only the primary agent maintains the plan",
    "never make artificial tool calls merely to populate UI panels",
  ]) {
    assert.ok(policy.includes(marker), `${name} planning contract missing: ${marker}`)
  }
}
for (const marker of [
  "plan_update",
  "1–7",
  "OPENCODE_VISIBLE_PLAN=strict",
  "Скрытые рассуждения не публикуй",
  "существенных вехах",
  "только ради UI",
]) {
  assert.ok(agentsPolicy.includes(marker), `Managed engineering planning contract missing: ${marker}`)
}
assert.ok(
  retiredPanel.includes('id: "custom.limits-panels-retired"'),
  "Old universal panel filename must be an inert migration tombstone",
)
assert.ok(
  !retiredPanel.includes("custom.universal-panel"),
  "Old universal host must not remain active",
)

const commands = await import(`${panelCommandUrl.href}?contract=${Date.now()}`)
assert.deepEqual(commands.parsePanelCommand("/panel"), { type: "configure" })
assert.deepEqual(commands.parsePanelCommand("/panel reset"), { type: "reset" })
assert.deepEqual(commands.parsePanelCommand("/panel left"), {
  type: "zone",
  side: "left",
  action: "show",
})
assert.deepEqual(commands.parsePanelCommand("/panel top limits"), {
  type: "zone",
  side: "top",
  action: "view",
  view: "limits",
})
assert.deepEqual(commands.parsePanelCommand("/panel right activity"), {
  type: "zone",
  side: "right",
  action: "view",
  view: "activity",
})
assert.deepEqual(commands.parsePanelCommand("/panel bottom history"), {
  type: "zone",
  side: "bottom",
  action: "view",
  view: "history",
})
assert.deepEqual(commands.parsePanelCommand("/panel слева план"), {
  type: "zone",
  side: "left",
  action: "view",
  view: "plan",
})
assert.deepEqual(commands.parsePanelCommand("/panel снизу орк"), {
  type: "zone",
  side: "bottom",
  action: "view",
  view: "orchestration",
})
assert.deepEqual(commands.parsePanelCommand("/panel right off"), {
  type: "zone",
  side: "right",
  action: "disable",
})
assert.deepEqual(commands.parsePanelCommand("/panel top pin"), {
  type: "zone",
  side: "top",
  action: "pin",
})
assert.deepEqual(commands.parsePanelCommand("/panel top unpin"), {
  type: "zone",
  side: "top",
  action: "unpin",
})
assert.deepEqual(commands.parsePanelCommand("/panel bottom collapse"), {
  type: "zone",
  side: "bottom",
  action: "collapse",
})
assert.deepEqual(commands.parsePanelCommand("/panel bottom expand"), {
  type: "zone",
  side: "bottom",
  action: "expand",
})
assert.deepEqual(commands.parsePanelCommand("/panel left end"), {
  type: "zone",
  side: "left",
  action: "end",
})
assert.equal(commands.parsePanelCommand("/not-panel left"), null)
assert.equal(commands.parsePanelCommand("/panel nowhere").type, "error")
assert.equal(
  commands.panelCommandID(commands.parsePanelCommand("/panel left")),
  "custom.panels.left.show",
)
assert.equal(
  commands.panelCommandID(commands.parsePanelCommand("/panel right activity")),
  "custom.panels.right.view.activity",
)
assert.equal(
  commands.panelCommandID(commands.parsePanelCommand("/panel bottom end")),
  "custom.panels.bottom.end",
)

const temp = await mkdtemp(join(tmpdir(), "custom-opencode-tui-"))

async function executable(name, source) {
  const path = join(temp, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, source, "utf8")
  await chmod(path, 0o755)
  return path
}

const invocations = join(temp, "invocations.log")
const stateDir = join(temp, "state")
await mkdir(stateDir, { recursive: true })
// Hermetic: never read the user's real Gemini state or auth files.
process.env.CUSTOM_OPENCODE_STATE_DIR = stateDir
process.env.HOME = join(temp, "home")
await mkdir(process.env.HOME, { recursive: true })

const codex = await executable(
  "codex",
  `#!/usr/bin/env python3
import json,os,sys
open(${JSON.stringify(invocations)},'a').write('codex '+' '.join(sys.argv[1:])+'\\n')
if sys.argv[1:] == ['--version']:
    print('codex-cli 0.100.0'); sys.exit(0)
for line in sys.stdin:
    row=json.loads(line)
    if row.get('method')=='initialize':
        print(json.dumps({'id':row['id'],'result':{'ok':True}}),flush=True)
    elif row.get('method')=='account/rateLimits/read':
        env=os.environ.get('TOKEN_PLAN_API_KEY','none')+'|'+os.environ.get('PATH','').split(os.pathsep)[0]
        print(json.dumps({'id':row['id'],'result':{'rateLimitsByLimitId':{'codex':{'planType':env,'primary':{'usedPercent':37,'windowDurationMins':300,'resetsAt':2000000000},'secondary':{'usedPercent':72,'windowDurationMins':10080,'resetsAt':2000100000}}}}}),flush=True)
`,
)
const bailian = await executable(
  "bl",
  `#!/usr/bin/env python3
import json
open(${JSON.stringify(invocations)},'a').write('bl\\n')
print(json.dumps({'planName':'Personal Pro','per5HourPercentage':0.375,'per5HourResetTime':2000000000000,'per1WeekPercentage':0.72,'per1WeekResetTime':2000100000000}))
`,
)

process.env.GEMINI_API_KEY = "fixture-gemini-key"
process.env.TOKEN_PLAN_API_KEY = "must-not-reach-provider-clis"
process.env.CODEX_BIN = codex
process.env.BAILIAN_CLI_BIN = bailian
process.env.OPENCODE_TUI_LIMITS_COMMAND_TIMEOUT_MS = "3000"

const invocationLines = async () => {
  try {
    return (await readFile(invocations, "utf8")).split("\n").filter(Boolean)
  } catch {
    return []
  }
}
const helper = await import(`${helperUrl.href}?normal=${Date.now()}`)
assert.equal(helper.getLimitsSync().codex.available, false)
await new Promise((resolve) => setTimeout(resolve, 150))
assert.deepEqual(await invocationLines(), [], "Importing or reading cached limits must not spawn provider CLIs")
assert.deepEqual(helper.getAutoRefreshState(), {
  owners: 0,
  active: false,
  ticking: false,
  pending: false,
  timeoutMs: 3000,
}, "No limits timer may run before a Limits view is mounted")

const limits = await helper.getLimits()
assert.equal(limits.codex.available, true)
assert.equal(limits.codex.primary.remainingPercent, 63)
assert.equal(limits.codex.secondary.remainingPercent, 28)
assert.equal(
  limits.codex.planType,
  `none|${temp}`,
  "Provider CLIs must get an allowlisted environment with their own bin dir first on PATH",
)
assert.equal(limits.qwen.available, true)
assert.equal(limits.qwen.planName, "Personal Pro")
assert.equal(limits.qwen.fiveHour.remainingPercent, 62.5)
assert.equal(limits.qwen.fiveHour.remainingCredits, 7500)
assert.equal(limits.qwen.sevenDay.remainingCredits, 11200)
assert.ok(limits.gemini)
assert.equal(limits.gemini.minuteTokens.limit, 2000000)
assert.equal(limits.gemini.dailyRequests.limit, 4000000)
assert.equal(helper.getLimitsSync(), helper.getLimitsSync(), "An unchanged snapshot must keep its identity")

helper.startAutoRefresh()
helper.startAutoRefresh()
assert.deepEqual(helper.getAutoRefreshState(), {
  owners: 2,
  active: true,
  ticking: true,
  pending: false,
  timeoutMs: 3000,
})
helper.stopAutoRefresh()
assert.equal(helper.getAutoRefreshState().owners, 1)
assert.equal(
  helper.getAutoRefreshState().active,
  true,
  "one plugin cleanup must not stop another plugin timer",
)
helper.stopAutoRefresh()
assert.equal(helper.getAutoRefreshState().owners, 0)
assert.equal(helper.getAutoRefreshState().active, false)
assert.equal(helper.getAutoRefreshState().ticking, false, "The last owner must stop the Gemini ticker")

// A mounted Limits view owns the feed: its first acquire refreshes, every
// release is idempotent and the last one stops all timers.
const feedHelper = await import(`${helperUrl.href}?feed=${Date.now()}`)
await writeFile(invocations, "", "utf8")
const changes = []
const releaseA = feedHelper.acquireLimits({ onChange: () => changes.push(feedHelper.getLimitsSync()) })
const releaseB = feedHelper.acquireLimits()
for (let attempt = 0; attempt < 100 && !feedHelper.getLimitsSync().codex.available; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 20))
}
assert.equal(feedHelper.getLimitsSync().codex.available, true, "Mounting a Limits view must load limits")
assert.ok(changes.length >= 1, "Limits listeners must be notified")
assert.equal((await invocationLines()).filter((line) => line.startsWith("codex app-server")).length, 1)
releaseA()
releaseA()
assert.equal(feedHelper.getAutoRefreshState().owners, 1, "Release must be idempotent")
releaseB()
assert.deepEqual(
  [feedHelper.getAutoRefreshState().active, feedHelper.getAutoRefreshState().ticking],
  [false, false],
  "Unmounting the last Limits view must stop every timer",
)

// Gemini 429 countdown watcher: one stat per poll, change-only callbacks, and
// a stale `active` file expires from its `until` timestamp.
assert.equal(helper.normalizeRateLimit(null), helper.INACTIVE_RATE_LIMIT)
assert.equal(helper.normalizeRateLimit({ active: true, until: 1_000, seconds: 9 }, 5_000), helper.INACTIVE_RATE_LIMIT)
assert.deepEqual(helper.normalizeRateLimit({ active: true, until: 10_000 }, 5_000), { active: true, seconds: 5, until: 10_000 })
assert.deepEqual(helper.normalizeRateLimit({ active: true, seconds: 7 }, 5_000), { active: true, seconds: 7, until: 0 })
assert.ok(helper.sameRateLimit({ active: true, seconds: 5, until: 1 }, { active: true, seconds: 5, until: 1 }))
assert.ok(!helper.sameRateLimit({ active: true, seconds: 5, until: 1 }, { active: true, seconds: 4, until: 1 }))
let watchClock = 100_000
const watchStates = [
  { active: false, seconds: 0 },
  { active: true, seconds: 3, until: 103_000 },
  { active: true, seconds: 3, until: 103_000 },
  { active: false, seconds: 0 },
]
const watched = []
let watchReads = 0
const stopWatch = helper.watchRateLimit((state) => watched.push(state), {
  activeMs: 250,
  now: () => watchClock,
  read: async () => watchStates[Math.min(watchReads++, watchStates.length - 1)],
})
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(watchReads, 1)
assert.deepEqual(watched, [], "An inactive state must not notify (no footer re-render)")
stopWatch()
const idleStop = helper.watchRateLimit(() => {}, { idleMs: 10, read: async () => { watchReads += 1; return null } })
const idleReadsBefore = watchReads
await new Promise((resolve) => setTimeout(resolve, 300))
idleStop()
assert.ok(watchReads - idleReadsBefore <= 1, "Idle polling must be at least two seconds apart")
let activeReads = 0
const activeStates = []
const stopActive = helper.watchRateLimit((state) => activeStates.push(state), {
  activeMs: 250,
  now: () => watchClock,
  read: async () => {
    activeReads += 1
    return activeReads < 3 ? { active: true, until: 103_000 } : null
  },
})
await new Promise((resolve) => setTimeout(resolve, 50))
watchClock += 1_000
await new Promise((resolve) => setTimeout(resolve, 300))
await new Promise((resolve) => setTimeout(resolve, 300))
stopActive()
assert.deepEqual(
  activeStates,
  [
    { active: true, seconds: 3, until: 103_000 },
    { active: true, seconds: 2, until: 103_000 },
    helper.INACTIVE_RATE_LIMIT,
  ],
  "An active countdown must poll quickly and report only changes",
)

// Newest installed Codex wins over PATH order (an old /usr/local/bin/codex
// cannot decode newer ChatGPT plan types), and the choice is cached.
const versionHome = join(temp, "version-home")
const versionFixture = (version) => `#!/usr/bin/env python3
import sys
open(${JSON.stringify(invocations)},'a').write('version ${version}\\n')
print('codex-cli ${version}')
`
const oldCodex = await executable("usr-local/codex", versionFixture("0.63.0"))
const midCodex = await executable("version-home/.local/bin/codex", versionFixture("0.144.1"))
const newCodex = await executable("version-home/.nvm/versions/node/v24.18.0/bin/codex", versionFixture("0.157.1"))
await executable("version-home/.nvm/versions/node/v9.0.0/bin/codex", versionFixture("0.1.0"))
const savedPath = process.env.PATH
const savedHome = process.env.HOME
// Only fixture binaries (plus a python3 for their shebang) are visible here,
// so no installed codex is ever probed by this test.
const pythonBin = join(temp, "python-bin")
await mkdir(pythonBin, { recursive: true })
await symlink(execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim(), join(pythonBin, "python3"))
delete process.env.CODEX_BIN
process.env.PATH = [dirname(oldCodex), pythonBin].join(":")
process.env.HOME = versionHome
const candidates = await helper.binaryCandidates("codex", { home: versionHome })
assert.equal(candidates[0], oldCodex, "PATH entries come first")
assert.ok(candidates.includes(midCodex) && candidates.includes(newCodex))
assert.ok(
  candidates.indexOf(newCodex) < candidates.indexOf(join(versionHome, ".nvm/versions/node/v9.0.0/bin/codex")),
  "Newer nvm versions must be listed first",
)
await writeFile(invocations, "", "utf8")
assert.equal(await helper.resolveCodexBinary(), newCodex, "The highest codex --version must win")
const probes = (await invocationLines()).filter((line) => line.startsWith("version")).length
assert.equal(await helper.resolveCodexBinary(), newCodex)
assert.equal(
  (await invocationLines()).filter((line) => line.startsWith("version")).length,
  probes,
  "The resolved binary must be cached",
)
process.env.CODEX_BIN = midCodex
assert.equal(await helper.resolveCodexBinary(), midCodex, "CODEX_BIN must pin the binary")
process.env.CODEX_BIN = join(temp, "missing-codex")
assert.equal(await helper.resolveCodexBinary(), null)
process.env.PATH = savedPath
process.env.HOME = savedHome
process.env.CODEX_BIN = codex

const beforeNight = Date.UTC(2026, 7, 30, 13, 59)
const atNight = Date.UTC(2026, 7, 30, 14, 0)
assert.equal(helper.getNightPromoStatus(beforeNight).active, false)
assert.equal(helper.getNightPromoStatus(beforeNight).minutesToToggle, 1)
assert.equal(helper.getNightPromoStatus(atNight).active, true)
assert.equal(helper.getNightPromoStatus(atNight).minutesToToggle, 600)
// OPENCODE_LIMITS_QWEN=0 (no Token Plan subscription): `bl` is never spawned.
for (const value of ["0", "off", "false", "no"]) {
  assert.equal(helper.qwenLimitsEnabled({ OPENCODE_LIMITS_QWEN: value }), false)
}
assert.equal(helper.qwenLimitsEnabled({}), true)
process.env.OPENCODE_LIMITS_QWEN = "0"
await writeFile(invocations, "", "utf8")
const disabledHelper = await import(`${helperUrl.href}?disabled=${Date.now()}`)
const disabledLimits = await disabledHelper.refreshLimits()
assert.equal(disabledLimits.qwen.reason, "disabled")
assert.equal(disabledLimits.codex.available, true)
assert.deepEqual(
  (await invocationLines()).filter((line) => line.startsWith("bl")),
  [],
  "Disabled Qwen limits must never spawn bl",
)
assert.ok(panelViews.includes("Alibaba: не используется"), "Disabled Qwen limits must read as unused, not missing")
delete process.env.OPENCODE_LIMITS_QWEN

// A missing CLI must not be searched for on every refresh.
process.env.BAILIAN_CLI_BIN = join(temp, "missing-bl")
const missingHelper = await import(`${helperUrl.href}?missing=${Date.now()}`)
assert.equal((await missingHelper.refreshLimits()).qwen.reason, "bailian-cli-not-found")
assert.ok(missingHelper.getLimitsBackoff("qwen").retryAt - Date.now() > 29 * 60_000, "bailian-cli-not-found must back off ~30 min")

// ChatGPT login missing: the token refresh is attempted only after a failed
// read, then the provider backs off ~30 min instead of spawning each refresh.
const noAuthCodex = await executable(
  "codex-noauth",
  `#!/usr/bin/env python3
import json,sys
log=open(${JSON.stringify(invocations)},'a')
log.write('noauth app-server\\n')
for line in sys.stdin:
    row=json.loads(line)
    log.write('noauth '+row.get('method','')+'\\n'); log.flush()
    if row.get('method')=='initialize':
        print(json.dumps({'id':row['id'],'result':{}}),flush=True)
    elif row.get('method')=='account/rateLimits/read':
        print(json.dumps({'id':row['id'],'error':{'message':'not signed in'}}),flush=True)
    elif row.get('method')=='account/read':
        assert row['params']=={'refreshToken':True}
        print(json.dumps({'id':row['id'],'result':{'requiresOpenaiAuth':True,'account':None}}),flush=True)
`,
)
process.env.CODEX_BIN = noAuthCodex
process.env.BAILIAN_CLI_BIN = bailian
await writeFile(invocations, "", "utf8")
const authHelper = await import(`${helperUrl.href}?auth=${Date.now()}`)
assert.equal((await authHelper.refreshLimits()).codex.reason, "codex-auth-required")
assert.deepEqual(
  (await invocationLines()).filter((line) => line.startsWith("noauth")),
  ["noauth app-server", "noauth initialize", "noauth initialized", "noauth account/rateLimits/read", "noauth account/read"],
  "The ChatGPT token refresh must follow only a failed limits read",
)
assert.equal((await authHelper.refreshLimits()).codex.reason, "codex-auth-required")
assert.equal(
  (await invocationLines()).filter((line) => line === "noauth app-server").length,
  1,
  "codex-auth-required must back off instead of respawning codex",
)
process.env.CODEX_BIN = codex

const expiredBailian = await executable(
  "bl-expired",
  `#!/usr/bin/env python3
import json, sys
open(${JSON.stringify(invocations)},'a').write('bl-expired\\n')
print(json.dumps({'error': {'code': 3, 'message': 'Console session is not logged in or has expired.', 'hint': 'Run \`bl auth login --console\` to sign in or refresh your console session.'}}))
sys.exit(3)
`,
)
process.env.BAILIAN_CLI_BIN = expiredBailian
const expiredHelper = await import(`${helperUrl.href}?expired=${Date.now()}`)
const expiredLimits = await expiredHelper.getLimits()
assert.equal(expiredLimits.qwen.available, false)
assert.equal(expiredLimits.qwen.state, "expired")
assert.equal(expiredLimits.qwen.reason, "session-expired")
assert.equal(
  expiredLimits.qwen.hint,
  "Run `bl auth login --console` to sign in or refresh your console session.",
)
await expiredHelper.refreshLimits()
await expiredHelper.refreshLimits()
assert.equal(
  (await invocationLines()).filter((line) => line === "bl-expired").length,
  1,
  "An expired/unpaid Alibaba session must not respawn bl on every refresh",
)
assert.ok(expiredHelper.getLimitsBackoff("qwen").retryAt - Date.now() > 29 * 60_000, "session-expired must back off ~30 min")

const grandchildPid = join(temp, "grandchild.pid")
const slowBailian = await executable(
  "bl-slow",
  `#!/usr/bin/env python3
import subprocess, time
child = subprocess.Popen(['sleep', '30'])
open(${JSON.stringify(grandchildPid)}, 'w').write(str(child.pid))
time.sleep(10)
`,
)
process.env.BAILIAN_CLI_BIN = slowBailian
process.env.OPENCODE_TUI_LIMITS_COMMAND_TIMEOUT_MS = "500"
const timeoutHelper = await import(`${helperUrl.href}?timeout=${Date.now()}`)
const started = Date.now()
const timed = await timeoutHelper.getLimits()
const elapsed = Date.now() - started
assert.equal(timed.qwen.available, false)
assert.equal(timed.qwen.reason, "bailian-cli-timeout")
assert.ok(elapsed < 2500, `Bailian watchdog took ${elapsed}ms`)
assert.equal(timeoutHelper.getAutoRefreshState().pending, false)
const orphan = Number(await readFile(grandchildPid, "utf8"))
let orphanAlive = true
for (let attempt = 0; attempt < 40 && orphanAlive; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50))
  try {
    process.kill(orphan, 0)
  } catch {
    orphanAlive = false
  }
}
assert.equal(orphanAlive, false, "A timed-out CLI must be killed with its whole process group")

await rm(temp, { recursive: true, force: true })
console.log(
  "TUI regression passed: native local /panel + four-zone dock + unified Activity/scroll + copy/mouse + limits watchdog",
)
