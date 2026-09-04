/** @jsxImportSource @opentui/solid */
/**
 * Four-zone workspace dock for OpenCode V2.
 * One manager owns left/right/top/bottom geometry; views never mutate layout.
 */
import { Plugin } from "@opencode-ai/plugin/tui"
import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { PANEL_DEFS, PANEL_IDS, createPanelViews } from "./lib/panel-views.jsx"
import { PANEL_SIDES, PANEL_VIEWS } from "./lib/panel-command.js"

const HANDLE = 1
const DEFAULT_SIDE_SIZE = 36
const DEFAULT_TOP_SIZE = 10
const DEFAULT_BOTTOM_SIZE = 12
const SIDE_LABEL = { left: "LEFT", right: "RIGHT", top: "TOP", bottom: "BOTTOM" }
const COLLAPSE_ICON = { left: "◂", right: "▸", top: "▴", bottom: "▾" }
const EXPAND_ICON = { left: "▸", right: "◂", top: "▾", bottom: "▴" }
const PIN_ICON = "📌"

function freshZones() {
  return {
    left: { enabled: false, active: "plan", pinned: true, collapsed: false, size: DEFAULT_SIDE_SIZE },
    right: { enabled: false, active: "plan", pinned: true, collapsed: false, size: DEFAULT_SIDE_SIZE },
    top: { enabled: false, active: "limits", pinned: true, collapsed: false, size: DEFAULT_TOP_SIZE },
    bottom: { enabled: false, active: "history", pinned: true, collapsed: false, size: DEFAULT_BOTTOM_SIZE },
  }
}

function currentRoute(context) {
  const current = context.ui.router.current
  return typeof current === "function" ? current() : current
}
function routeSessionID(context) {
  const route = currentRoute(context)
  const type = route?.type ?? route?.name
  if (type !== "session") return ""
  return String(route?.sessionID ?? route?.params?.sessionID ?? "")
}
function panelTitle(id) {
  return PANEL_DEFS.find((item) => item.id === id)?.title ?? id
}
function isVertical(side) {
  return side === "left" || side === "right"
}

export default Plugin.define({
  id: "custom.workspace-panel",
  setup(context) {
    const theme = context.theme
    const renderer = context.renderer
    const views = createPanelViews(context)
    const PanelContent = views.PanelContent

    // Migrate the universal right panel that landed in the new main.
    const [legacyUniversal] = context.storage.store("universal-panel.state", {
      initial: { open: false, pinned: false, tab: "plan" },
    })
    const [state, updateState] = context.storage.store("workspace-panel.state", {
      initial: { version: 3, zones: freshZones(), migratedUniversalV1: false },
    })

    // Migrate the previous one-sidebar panels branch schema.
    if (!state.zones) {
      const zones = freshZones()
      zones.right.enabled = true
      if (PANEL_IDS.includes(state.active)) zones.right.active = state.active
      if (typeof state.pinned === "boolean") zones.right.pinned = state.pinned
      updateState((draft) => {
        draft.version = 3
        draft.zones = zones
        draft.migratedUniversalV1 = false
        delete draft.active
        delete draft.pinned
      })
    }

    if (state.migratedUniversalV1 !== true) {
      updateState((draft) => {
        if (!draft.zones) draft.zones = freshZones()
        const right = draft.zones.right ?? (draft.zones.right = freshZones().right)
        if (PANEL_IDS.includes(legacyUniversal.tab)) right.active = legacyUniversal.tab
        if (typeof legacyUniversal.pinned === "boolean") right.pinned = legacyUniversal.pinned
        if (legacyUniversal.open === true) {
          right.enabled = true
          right.collapsed = false
        }
        draft.version = 3
        draft.migratedUniversalV1 = true
      })
    }

    function zone(side) {
      return state.zones?.[side] ?? freshZones()[side]
    }
    function mutateZone(side, mutate) {
      if (!PANEL_SIDES.includes(side)) return
      updateState((draft) => {
        if (!draft.zones) draft.zones = freshZones()
        if (!draft.zones[side]) draft.zones[side] = freshZones()[side]
        mutate(draft.zones[side])
      })
      scheduleDockLayout()
    }
    function showZone(side) {
      mutateZone(side, (item) => { item.enabled = true; item.collapsed = false })
    }
    function disableZone(side) {
      mutateZone(side, (item) => { item.enabled = false; item.collapsed = false })
    }
    function setZoneView(side, view) {
      if (!PANEL_IDS.includes(view)) return
      mutateZone(side, (item) => { item.enabled = true; item.collapsed = false; item.active = view })
    }
    function setPinned(side, pinned) {
      mutateZone(side, (item) => { item.enabled = true; item.pinned = pinned })
    }
    function setCollapsed(side, collapsed) {
      mutateZone(side, (item) => { item.enabled = true; item.collapsed = collapsed })
    }
    function toggleZone(side) {
      const item = zone(side)
      if (!item.enabled || item.collapsed) showZone(side)
      else setCollapsed(side, true)
    }
    function adjustSize(side, delta) {
      mutateZone(side, (item) => {
        const vertical = isVertical(side)
        const min = vertical ? 24 : 6
        const terminal = vertical ? Number(renderer.width ?? 120) : Number(renderer.height ?? 30)
        const max = Math.max(min, Math.floor(terminal * 0.45))
        item.size = Math.max(min, Math.min(max, Number(item.size ?? (vertical ? DEFAULT_SIDE_SIZE : 10)) + delta))
      })
    }
    function cycleZoneView(side, direction) {
      const item = zone(side)
      const index = Math.max(0, PANEL_IDS.indexOf(item.active))
      setZoneView(side, PANEL_IDS[(index + direction + PANEL_IDS.length) % PANEL_IDS.length])
    }
    function resetZones() {
      updateState((draft) => {
        draft.version = 3
        draft.zones = freshZones()
        draft.migratedUniversalV1 = true
      })
      scheduleDockLayout()
    }

    function extent(side) {
      const item = zone(side)
      if (!item.enabled) return 0
      if (item.collapsed) return HANDLE
      const vertical = isVertical(side)
      const raw = Number(item.size ?? (vertical ? DEFAULT_SIDE_SIZE : 10))
      const terminal = vertical ? Number(renderer.width ?? 120) : Number(renderer.height ?? 30)
      const min = vertical ? 24 : 6
      const max = Math.max(min, Math.floor(terminal * 0.45))
      return Math.max(min, Math.min(max, raw))
    }
    function reserved(side) {
      const item = zone(side)
      return item.enabled && item.pinned ? extent(side) : 0
    }

    // The host is the only layout owner.
    let anchorNode = null
    let dockTarget = null
    let baseline = null
    let dockRetry = null
    let dockScheduled = false
    let disposed = false

    function restoreDockTarget() {
      if (!dockTarget || !baseline) return
      dockTarget.paddingLeft = baseline.left
      dockTarget.paddingRight = baseline.right
      dockTarget.paddingTop = baseline.top
      dockTarget.paddingBottom = baseline.bottom
      dockTarget = null
      baseline = null
    }
    function findDockTarget() {
      let parent = anchorNode?.parent
      while (parent) {
        const height = Number(renderer.height ?? 0)
        const width = Number(renderer.width ?? 0)
        const candidates = (parent.getChildren?.() ?? [])
          .filter((child) => child !== anchorNode && child.getChildrenCount?.() > 0)
          .filter((child) => !height || Number(child.height ?? 0) >= height / 2)
          .filter((child) => !width || Number(child.width ?? 0) >= width / 2)
          .sort((a, b) => Number(b.width ?? 0) * Number(b.height ?? 0) - Number(a.width ?? 0) * Number(a.height ?? 0))
        if (candidates.length) return candidates[0]
        parent = parent.parent
      }
      return null
    }
    function syncDockLayout() {
      if (disposed) return
      dockScheduled = false
      const target = findDockTarget()
      if (!target) {
        restoreDockTarget()
        if (!dockRetry) dockRetry = setTimeout(() => {
          if (disposed) return
          dockRetry = null
          syncDockLayout()
        }, 50)
        return
      }
      if (dockTarget !== target) {
        restoreDockTarget()
        dockTarget = target
        baseline = {
          left: Number(target.paddingLeft ?? 0),
          right: Number(target.paddingRight ?? 0),
          top: Number(target.paddingTop ?? 0),
          bottom: Number(target.paddingBottom ?? 0),
        }
      }
      target.paddingLeft = baseline.left + reserved("left")
      target.paddingRight = baseline.right + reserved("right")
      target.paddingTop = baseline.top + reserved("top")
      target.paddingBottom = baseline.bottom + reserved("bottom")
      renderer.requestRender?.()
    }
    function scheduleDockLayout() {
      if (disposed || dockScheduled) return
      dockScheduled = true
      queueMicrotask(() => {
        if (!disposed) syncDockLayout()
      })
    }

    // Preserve new main's cursor-under-overlay protection, generalized to all sides.
    function cursorUnderOverlay(cursor) {
      const x = Number(cursor?.x ?? 0)
      const y = Number(cursor?.y ?? 0)
      const width = Number(renderer.width ?? 0)
      const height = Number(renderer.height ?? 0)
      for (const side of PANEL_SIDES) {
        const item = zone(side)
        if (!item.enabled || item.pinned || item.collapsed) continue
        const size = extent(side)
        if (side === "left" && x < size) return true
        if (side === "right" && x > width - size) return true
        if (side === "top" && y < size) return true
        if (side === "bottom" && y > height - size) return true
      }
      return false
    }
    const hideCursorUnderPanels = () => {
      try {
        const cursor = renderer.getCursorState?.()
        if (cursor?.visible && cursorUnderOverlay(cursor)) renderer.setCursorPosition(0, 0, false)
      } catch {}
    }
    renderer.addPostProcessFn?.(hideCursorUnderPanels)

    const scrollPositions = new Map()
    const scrollRefs = new Map()
    function scrollKey(side, sessionID, view) {
      return `${side}:${sessionID || "home"}:${view}`
    }
    function saveScrollPosition(key, node) {
      if (!key || !node || node.isDestroyed) return
      const top = Number(node.scrollTop ?? 0)
      const max = Math.max(0, Number(node.scrollHeight ?? 0) - Number(node.viewport?.height ?? 0))
      scrollPositions.set(key, { top, atBottom: top >= max })
    }
    function scrollToEnd(node) {
      if (typeof node?.scrollTo === "function") node.scrollTo(Number.MAX_SAFE_INTEGER)
    }
    function jumpToEnd(side) {
      const node = scrollRefs.get(side)
      try { scrollToEnd(node) } catch {}
    }

    function Tab(props) {
      const active = () => zone(props.side).active === props.view
      return (
        <box paddingX={1} onMouseDown={(event) => { event?.stopPropagation?.(); setZoneView(props.side, props.view) }}>
          <text fg={active() ? theme.text.formfield.$selected : theme.text.subdued}><span>{active() ? `[${props.label}]` : props.label}</span></text>
        </box>
      )
    }
    function Handle(props) {
      return (
        <box width="100%" height="100%" justifyContent="center" alignItems="center" onMouseDown={() => setCollapsed(props.side, false)}>
          <text fg={theme.text.subdued}><span>{EXPAND_ICON[props.side]}</span></text>
        </box>
      )
    }
    function ExpandedHandle(props) {
      const vertical = isVertical(props.side)
      const atStart = props.side === "right" || props.side === "bottom"
      return (
        <box
          position="absolute"
          zIndex={1}
          {...(vertical
            ? { [atStart ? "left" : "right"]: 0, top: 0, width: HANDLE, height: "100%" }
            : { [atStart ? "top" : "bottom"]: 0, left: 0, height: HANDLE, width: "100%" })}
          justifyContent="center"
          alignItems="center"
          onMouseDown={(event) => { event?.stopPropagation?.(); setCollapsed(props.side, true) }}
        >
          <text fg={theme.text.subdued}><span>{COLLAPSE_ICON[props.side]}</span></text>
        </box>
      )
    }
    function Zone(props) {
      const item = () => zone(props.side)
      const sessionID = () => routeSessionID(context)
      let scroll = null
      let previousKey = ""

      createEffect(() => {
        const key = scrollKey(props.side, sessionID(), item().active)
        saveScrollPosition(previousKey, scroll)
        previousKey = key
        queueMicrotask(() => {
          if (!scroll || scroll.isDestroyed) return
          const saved = scrollPositions.get(key)
          if (!saved || saved.atBottom) scrollToEnd(scroll)
          else if (typeof scroll.scrollTo === "function") scroll.scrollTo({ y: saved.top })
          else if ("scrollTop" in scroll) scroll.scrollTop = saved.top
        })
      })
      onCleanup(() => {
        saveScrollPosition(previousKey, scroll)
        scrollRefs.delete(props.side)
      })

      const vertical = () => isVertical(props.side)
      const leftOffset = () => props.side === "top" || props.side === "bottom" ? reserved("left") : undefined
      const rightOffset = () => props.side === "top" || props.side === "bottom" ? reserved("right") : undefined
      const topOffset = () => props.side === "left" || props.side === "right" ? reserved("top") : props.side === "top" ? 0 : undefined
      const bottomOffset = () => props.side === "left" || props.side === "right" ? reserved("bottom") : props.side === "bottom" ? 0 : undefined
      const leftEdge = () => props.side === "left" ? 0 : leftOffset()
      const rightEdge = () => props.side === "right" ? 0 : rightOffset()

      return (
        <Show when={item().enabled}>
          <box
            position="absolute"
            zIndex={1500}
            top={topOffset()}
            bottom={bottomOffset()}
            left={leftEdge()}
            right={rightEdge()}
            width={vertical() ? extent(props.side) : undefined}
            height={!vertical() ? extent(props.side) : undefined}
            minWidth={vertical() ? HANDLE : 0}
            minHeight={!vertical() ? HANDLE : 0}
            backgroundColor={theme.background.default}
            border={props.side === "left" ? ["right"] : props.side === "right" ? ["left"] : props.side === "top" ? ["bottom"] : ["top"]}
            borderColor={theme.border.default}
            flexDirection="column"
          >
            <Show when={!item().collapsed} fallback={<Handle side={props.side} />}>
              <box flexDirection="column" flexShrink={0} paddingX={1} paddingTop={1} gap={1}>
                <box flexDirection="row" justifyContent="space-between" width="100%">
                  <box flexDirection="row" gap={1}>
                    <text fg={theme.text.subdued}><span>{SIDE_LABEL[props.side]}</span></text>
                    <text fg={theme.text.default}><b>{panelTitle(item().active)}</b></text>
                  </box>
                  <box flexDirection="row" gap={1}>
                    <box backgroundColor={item().pinned ? theme.background.action.primary.default : undefined} onMouseDown={() => setPinned(props.side, !item().pinned)}><text fg={item().pinned ? theme.text.action.primary.default : theme.text.subdued}><span>{PIN_ICON}</span></text></box>
                    <box onMouseDown={() => disableZone(props.side)}><text fg={theme.text.subdued}><span>×</span></text></box>
                  </box>
                </box>
                <box flexDirection="row" flexWrap="wrap" width="100%">
                  <For each={PANEL_DEFS}>{(panel) => <Tab side={props.side} view={panel.id} label={panel.short} />}</For>
                </box>
              </box>
              <scrollbox
                ref={(node) => { scroll = node; scrollRefs.set(props.side, node) }}
                flexGrow={1}
                minHeight={0}
                width="100%"
                marginRight={props.side === "left" ? HANDLE : 0}
                marginLeft={props.side === "right" ? HANDLE : 0}
                scrollY={true}
                stickyScroll={true}
                stickyStart="bottom"
                viewportOptions={{ paddingRight: 1 }}
                verticalScrollbarOptions={{
                  visible: true,
                  paddingLeft: 1,
                  trackOptions: { backgroundColor: theme.background.surface.offset, foregroundColor: theme.scrollbar.default },
                }}
              >
                <box flexDirection="column" paddingX={1} paddingTop={1} paddingBottom={1} gap={1} flexShrink={0}>
                  <PanelContent view={item().active} sessionID={sessionID()} />
                </box>
              </scrollbox>
              <box flexDirection="row" justifyContent="flex-end" paddingX={1} marginRight={props.side === "left" ? HANDLE : 0} flexShrink={0}>
                <box onMouseDown={() => jumpToEnd(props.side)}><text fg={theme.text.action.secondary.default}><span>↓ конец</span></text></box>
              </box>
              <ExpandedHandle side={props.side} />
            </Show>
          </box>
        </Show>
      )
    }

    function applyZoneAction(side, action) {
      const value = action?.value ?? action
      if (!value) return
      if (value === "show") showZone(side)
      else if (value === "pin") setPinned(side, true)
      else if (value === "unpin") setPinned(side, false)
      else if (value === "collapse") setCollapsed(side, true)
      else if (value === "expand") setCollapsed(side, false)
      else if (value === "disable") disableZone(side)
      else if (value === "grow") adjustSize(side, isVertical(side) ? 4 : 2)
      else if (value === "shrink") adjustSize(side, isVertical(side) ? -4 : -2)
      else if (value === "end") jumpToEnd(side)
      else if (String(value).startsWith("view:")) setZoneView(side, String(value).slice(5))
    }

    function configureZone(side) {
      const DialogSelect = context.ui.DialogSelect
      const item = zone(side)
      context.ui.dialog.replace(() => (
        <DialogSelect
          title={`${SIDE_LABEL[side]} panel`}
          placeholder="Настроить зону…"
          options={[
            { title: item.enabled ? "Показать / развернуть" : "Включить", value: "show", description: `Сейчас: ${item.enabled ? panelTitle(item.active) : "выключена"}` },
            ...PANEL_DEFS.map((view) => ({ title: `View: ${view.title}`, value: `view:${view.id}`, description: view.id === item.active ? "Текущий вид" : undefined })),
            { title: item.pinned ? "Unpin → overlay" : "Pin → dock", value: item.pinned ? "unpin" : "pin" },
            { title: item.collapsed ? "Развернуть" : "Свернуть", value: item.collapsed ? "expand" : "collapse" },
            { title: isVertical(side) ? "Шире +4" : "Выше +2", value: "grow" },
            { title: isVertical(side) ? "Уже −4" : "Ниже −2", value: "shrink" },
            { title: "Перейти в конец", value: "end" },
            { title: "Выключить зону", value: "disable" },
          ]}
          onSelect={(option) => {
            context.ui.dialog.clear()
            applyZoneAction(side, option)
          }}
        />
      ))
    }

    function configurePanels() {
      const DialogSelect = context.ui.DialogSelect
      context.ui.dialog.replace(() => (
        <DialogSelect
          title="Panels"
          placeholder="Выбрать dock-зону…"
          options={PANEL_SIDES.map((side) => {
            const item = zone(side)
            return {
              title: SIDE_LABEL[side],
              value: side,
              description: item.enabled
                ? `${panelTitle(item.active)} · ${item.pinned ? "pinned" : "overlay"}${item.collapsed ? " · collapsed" : ""} · ${extent(side)}`
                : "disabled",
            }
          })}
          onSelect={(option) => {
            context.ui.dialog.clear()
            configureZone(option.value)
          }}
        />
      ))
    }

    function runZoneAction(side, action, view) {
      if (action === "show") showZone(side)
      else if (action === "disable") disableZone(side)
      else if (action === "pin") setPinned(side, true)
      else if (action === "unpin") setPinned(side, false)
      else if (action === "collapse") setCollapsed(side, true)
      else if (action === "expand") setCollapsed(side, false)
      else if (action === "end") jumpToEnd(side)
      else if (action === "view") setZoneView(side, view)
    }

    function commandRows() {
      const rows = [
        {
          id: "custom.panels.configure",
          title: "Настроить панели",
          description: "Left / right / top / bottom dock zones",
          group: "Панели",
          slash: { name: "panel" },
          palette: true,
          suggested: true,
          run: configurePanels,
        },
        { id: "custom.panels.reset", title: "Сбросить раскладку панелей", group: "Панели", palette: true, run: resetZones },

        // Compatibility with the universal right panel merged into main.
        { id: "custom.panel.toggle", title: "Workspace panel: показать/скрыть", group: "Панели", bind: "ctrl+alt+u", palette: true, run: () => toggleZone("right") },
        { id: "custom.panel.activity", title: "Workspace: Activity", group: "Панели", bind: "ctrl+alt+a", palette: true, run: () => setZoneView("right", "activity") },
        { id: "custom.panel.plan", title: "Workspace: Plan", group: "Панели", bind: "ctrl+alt+t", palette: true, run: () => setZoneView("right", "plan") },
        { id: "custom.panel.limits", title: "Workspace: Limits", group: "Панели", bind: "ctrl+alt+l", palette: true, run: () => setZoneView("right", "limits") },
        { id: "custom.panel.end", title: "Workspace: перейти в конец", group: "Панели", bind: "ctrl+alt+end", palette: true, run: () => jumpToEnd("right") },

        // Compatibility with the earlier panels branch commands.
        { id: "custom.panels.toggle", title: "Правая панель: показать/свернуть", group: "Панели", bind: "ctrl+alt+p", palette: false, run: () => toggleZone("right") },
        { id: "custom.panels.pin", title: "Правая панель: pin/unpin", group: "Панели", palette: false, run: () => setPinned("right", !zone("right").pinned) },
        { id: "custom.panels.previous", title: "Правая панель: предыдущий View", group: "Панели", palette: false, run: () => cycleZoneView("right", -1) },
        { id: "custom.panels.next", title: "Правая панель: следующий View", group: "Панели", palette: false, run: () => cycleZoneView("right", 1) },
      ]
      for (const view of PANEL_VIEWS) {
        rows.push({ id: `custom.panels.${view}`, title: `Правая панель: ${panelTitle(view)}`, group: "Панели", palette: false, run: () => setZoneView("right", view) })
      }
      for (const side of PANEL_SIDES) {
        for (const action of ["show", "disable", "pin", "unpin", "collapse", "expand", "end"]) {
          rows.push({
            id: `custom.panels.${side}.${action}`,
            title: `${SIDE_LABEL[side]}: ${action}`,
            group: "Панели",
            palette: action === "show",
            run: () => runZoneAction(side, action),
          })
        }
        for (const view of PANEL_VIEWS) {
          rows.push({
            id: `custom.panels.${side}.view.${view}`,
            title: `${SIDE_LABEL[side]}: ${panelTitle(view)}`,
            group: "Панели",
            palette: false,
            run: () => runZoneAction(side, "view", view),
          })
        }
      }
      return rows
    }

    function NativeSidebarGuard() {
      onMount(() => {
        // The stock sidebar would be a fifth panel. This slot only mounts while
        // it is visible; the native toggle then moves auto -> hide on wide TTYs.
        queueMicrotask(() => context.keymap.dispatch("session.sidebar.toggle"))
      })
      return null
    }

    const unNativeSidebar = context.ui.slot({
      append: "sidebar_content",
      render: () => <NativeSidebarGuard />,
    })

    const unApp = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({ mode: "global", priority: 120, commands: commandRows() }))

        createEffect(() => {
          for (const side of PANEL_SIDES) {
            const item = zone(side)
            item.enabled
            item.pinned
            item.collapsed
            item.size
          }
          Number(renderer.width ?? 0)
          Number(renderer.height ?? 0)
          scheduleDockLayout()
        })

        onCleanup(() => restoreDockTarget())
        return (
          <>
            <box
              ref={(node) => { anchorNode = node; scheduleDockLayout() }}
              position="absolute"
              top={0}
              left={0}
              width={1}
              height={1}
            />
            <For each={PANEL_SIDES}>{(side) => <Zone side={side} />}</For>
          </>
        )
      },
    })

    return () => {
      disposed = true
      if (dockRetry) clearTimeout(dockRetry)
      restoreDockTarget()
      renderer.removePostProcessFn?.(hideCursorUnderPanels)
      unNativeSidebar?.()
      unApp?.()
      views.dispose()
    }
  },
})
