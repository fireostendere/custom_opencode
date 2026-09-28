// Native DialogSelect hides its option scrollbar and always shows its Search
// input. Show both only while the options overflow (or a filter is active).
//
// Cost model: the renderer runs post-process hooks after every frame, and
// renderable setters (verticalScrollbarOptions in particular) request the
// next frame. Assigning them unconditionally from a post-process hook turns
// into a permanent 60 fps render loop plus a full render-tree walk per frame
// while any select dialog is open. Therefore:
// - the full tree is walked once when a dialog opens (and a bounded number of
//   times until the dialog subtree is found); afterwards only the cached
//   dialog subtree is visited;
// - after the first layout, frames are synced at most every SYNC_INTERVAL_MS
//   with one trailing sync, instead of on every frame;
// - properties are assigned only when their value actually changes.
const SYNC_INTERVAL_MS = 120
const EAGER_FRAMES = 12
const MAX_DISCOVERY_WALKS = 20

function collect(root, into = new Set()) {
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()
    if (!node || into.has(node)) continue
    into.add(node)
    const children = node.getChildren?.()
    if (children) for (const child of children) pending.push(child)
  }
  return into
}

function topNewAncestor(node, existing) {
  let root = node
  while (root.parent && !existing.has(root.parent)) root = root.parent
  return root
}

function dialogParts(root, placeholder) {
  const scrollbars = []
  const searches = []
  for (const node of collect(root)) {
    if (node.isDestroyed) continue
    if (node.verticalScrollBar) scrollbars.push(node)
    if (node.placeholder === placeholder) searches.push(node)
  }
  return { scrollbars, searches }
}

function isDialogRoot(root, placeholder) {
  const { scrollbars, searches } = dialogParts(root, placeholder)
  return scrollbars.length > 0 && searches.length > 0
}

// Native DialogSelect focuses its filter input one tick after mounting; a
// Search hidden before that tick must be focused again when it is revealed.
function wantsFocus(node, original) {
  return Boolean(original.focused || node.traits?.status === "FILTER")
}

export function installDialogScrollbars(context, options = {}) {
  const dialog = context.ui.dialog
  const renderer = context.renderer
  const select = dialog.select
  if (typeof select !== "function") return () => {}
  const interval = Math.max(0, Number(options.interval ?? SYNC_INTERVAL_MS))
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay))
  const clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer))

  async function selectWithScrollbar(selectOptions) {
    const existing = collect(renderer.root)
    const scrollbars = new Map()
    const searches = new Map()
    const hidden = new Set()
    const searchPlaceholder = selectOptions?.placeholder ?? "Search"
    let dialogRoot
    let discoveryWalks = 0
    let layoutKnown = false
    let eagerFrames = 0
    let lastSync = 0
    let timer = null
    let closed = false

    function discover() {
      const focused = renderer.currentFocusedRenderable
      if (focused && !existing.has(focused) && focused.placeholder === searchPlaceholder) {
        const root = topNewAncestor(focused, existing)
        if (isDialogRoot(root, searchPlaceholder)) return root
      }
      if (discoveryWalks >= MAX_DISCOVERY_WALKS) return undefined
      discoveryWalks += 1
      const roots = new Set()
      for (const node of collect(renderer.root)) {
        if (!existing.has(node)) roots.add(topNewAncestor(node, existing))
      }
      for (const root of roots) {
        if (isDialogRoot(root, searchPlaceholder)) return root
      }
      return undefined
    }

    function hideSearch(node) {
      if (node.focused) node.blur?.()
      if (node.focusable !== false) node.focusable = false
      if (node.visible !== false) node.visible = false
      hidden.add(node)
    }

    function showSearch(node, original) {
      if (node.visible !== original.visible) node.visible = original.visible
      if (node.focusable !== original.focusable) node.focusable = original.focusable
      if (hidden.delete(node) && wantsFocus(node, original) && !node.focused) node.focus?.()
    }

    function sync() {
      if (closed) return
      if (!dialogRoot || dialogRoot.isDestroyed) {
        dialogRoot = discover()
        if (!dialogRoot) return
      }
      const parts = dialogParts(dialogRoot, searchPlaceholder)
      let overflow = false
      for (const node of parts.scrollbars) {
        const scrollbar = node.verticalScrollBar
        if (scrollbar.viewportSize > 0) layoutKnown = true
        if (scrollbar.scrollSize > scrollbar.viewportSize) overflow = true
      }
      for (const node of parts.scrollbars) {
        if (!scrollbars.has(node)) scrollbars.set(node, node.verticalScrollBar.visible)
        // The setter requests a render even for an unchanged value.
        if (node.verticalScrollBar.visible !== overflow) node.verticalScrollbarOptions = { visible: overflow }
      }
      for (const node of parts.searches) {
        if (!searches.has(node)) {
          searches.set(node, { visible: node.visible, focusable: node.focusable, focused: node.focused })
        }
        if (overflow || node.value) showSearch(node, searches.get(node))
        else hideSearch(node)
      }
    }

    function runSync() {
      timer = null
      lastSync = now()
      sync()
    }

    // Post-process hook: O(1) unless a sync is due.
    function onFrame() {
      if (closed) return
      const settled = (dialogRoot && layoutKnown) || discoveryWalks >= MAX_DISCOVERY_WALKS
      if (!settled && eagerFrames < EAGER_FRAMES) {
        eagerFrames += 1
        runSync()
        return
      }
      const wait = interval - (now() - lastSync)
      if (wait <= 0) {
        if (timer) clearTimer(timer)
        runSync()
      } else if (!timer) {
        timer = setTimer(runSync, wait)
        timer?.unref?.()
      }
    }

    renderer.addPostProcessFn?.(onFrame)
    try {
      const result = select.call(dialog, selectOptions)
      runSync()
      return await result
    } finally {
      closed = true
      if (timer) clearTimer(timer)
      timer = null
      renderer.removePostProcessFn?.(onFrame)
      for (const [node, visible] of scrollbars) {
        if (!node.isDestroyed && node.verticalScrollBar?.visible !== visible) node.verticalScrollbarOptions = { visible }
      }
      for (const [node, original] of searches) {
        if (node.isDestroyed) continue
        if (node.visible !== original.visible) node.visible = original.visible
        if (node.focusable !== original.focusable) node.focusable = original.focusable
        if (original.focused && !node.focused) node.focus?.()
        if (!original.focused && node.focused) node.blur?.()
      }
    }
  }

  dialog.select = selectWithScrollbar
  return () => {
    if (dialog.select === selectWithScrollbar) dialog.select = select
  }
}
