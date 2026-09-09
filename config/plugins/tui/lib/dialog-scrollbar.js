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
    const touched = new Set()
    const reveal = () => {
      for (const node of renderTree(renderer.root)) {
        if (existing.has(node) || node.verticalScrollBar?.visible !== false) continue
        node.verticalScrollbarOptions = { visible: true }
        touched.add(node)
      }
    }
    renderer.addPostProcessFn?.(reveal)
    try {
      const result = select.call(dialog, options)
      reveal()
      return await result
    } finally {
      renderer.removePostProcessFn?.(reveal)
      for (const node of touched) {
        if (!node.isDestroyed) node.verticalScrollbarOptions = { visible: false }
      }
    }
  }

  dialog.select = selectWithScrollbar
  return () => {
    if (dialog.select === selectWithScrollbar) dialog.select = select
  }
}
