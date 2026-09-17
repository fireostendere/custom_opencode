function renderTree(root) {
  const found = new Set()
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()
    if (!node || found.has(node)) continue
    found.add(node)
    pending.push(...(node.getChildren?.() ?? []))
  }
  return found
}

export function installDialogScrollbars(context) {
  const dialog = context.ui.dialog
  const renderer = context.renderer
  const select = dialog.select
  if (typeof select !== "function") return () => {}

  async function selectWithScrollbar(options) {
    const existing = renderTree(renderer.root)
    const scrollbars = new Map()
    const searches = new Map()
    const searchPlaceholder = options?.placeholder ?? "Search"
    let dialogRoot
    const sync = () => {
      const groups = new Map()
      for (const node of renderTree(renderer.root)) {
        if (existing.has(node)) continue
        let root = node
        while (root.parent && !existing.has(root.parent)) root = root.parent
        const group = groups.get(root) ?? []
        group.push(node)
        groups.set(root, group)
      }
      if (!dialogRoot) {
        for (const [root, nodes] of groups) {
          if (nodes.some(node => node.placeholder === searchPlaceholder) && nodes.some(node => node.verticalScrollBar)) {
            dialogRoot = root
            break
          }
        }
      }
      const nodes = groups.get(dialogRoot)
      if (!nodes) return
      const overflow = nodes.some(node => {
        const scrollbar = node.verticalScrollBar
        return scrollbar && scrollbar.scrollSize > scrollbar.viewportSize
      })
      for (const node of nodes) {
        if (node.verticalScrollBar) {
          if (!scrollbars.has(node)) scrollbars.set(node, node.verticalScrollBar.visible)
          node.verticalScrollbarOptions = { visible: overflow }
        }
        if (node.placeholder === searchPlaceholder) {
          if (!searches.has(node)) {
            searches.set(node, {
              visible: node.visible,
              focusable: node.focusable,
              focused: node.focused,
            })
          }
          const original = searches.get(node)
          if (overflow || node.value) {
            node.visible = original.visible
            node.focusable = original.focusable
            if (original.focused && !node.focused) node.focus?.()
          } else {
            if (node.focused) node.blur?.()
            node.focusable = false
            node.visible = false
          }
        }
      }
    }
    renderer.addPostProcessFn?.(sync)
    try {
      const result = select.call(dialog, options)
      sync()
      return await result
    } finally {
      renderer.removePostProcessFn?.(sync)
      for (const [node, visible] of scrollbars) {
        if (!node.isDestroyed) node.verticalScrollbarOptions = { visible }
      }
      for (const [node, original] of searches) {
        if (node.isDestroyed) continue
        node.visible = original.visible
        node.focusable = original.focusable
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
