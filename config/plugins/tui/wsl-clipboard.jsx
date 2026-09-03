import { Plugin } from "@opencode-ai/plugin/tui"
import { isWSL, materializeClipboardPNG, readWindowsClipboard } from "./lib/wsl-clipboard.js"

function isOpenCodePrompt(editor) {
  const traits = editor?.traits ?? {}
  return Boolean(editor && !editor.isDestroyed && traits.owner === "opencode" && traits.role === "prompt" && traits.status !== "SHELL")
}

function focusedPrompt(context) {
  return context.renderer?.currentFocusedEditor ?? context.renderer?.currentFocusedRenderable
}

function warning(context, message) {
  if (typeof context.ui.toast?.show === "function") context.ui.toast.show({ message, variant: "warning" })
  else context.ui.toast?.({ message, variant: "warning" })
}

export default Plugin.define({
  id: "custom.wsl-clipboard",
  setup(context) {
    if (!isWSL()) return
    let disposed = false
    let injecting = false
    let queue = Promise.resolve()
    let warned = false
    const cleanups = new Set()

    function valid(editor) {
      return !disposed && focusedPrompt(context) === editor && isOpenCodePrompt(editor)
    }

    function inject(editor, bytes, metadata) {
      if (!valid(editor)) return
      injecting = true
      try {
        context.renderer.keyInput.processPaste(bytes, metadata)
      } finally {
        injecting = false
      }
    }

    async function paste(editor, fallback) {
      let clipboard
      try {
        clipboard = await readWindowsClipboard()
      } catch {
        if (disposed) return
        if (fallback?.length && valid(editor)) {
          inject(editor, fallback, { mimeType: "text/plain", kind: "text" })
          return
        }
        if (!warned) {
          warned = true
          warning(context, "Windows clipboard is unavailable; using native paste")
        }
        if (valid(editor)) context.keymap.dispatch("prompt.paste")
        return
      }
      if (!valid(editor)) return
      if (clipboard.kind === "empty") {
        if (fallback?.length) inject(editor, fallback, { mimeType: "text/plain", kind: "text" })
        return
      }
      if (clipboard.kind === "text") {
        inject(editor, clipboard.bytes, { mimeType: "text/plain", kind: "text" })
        return
      }
      let file
      try {
        file = await materializeClipboardPNG(clipboard.bytes)
        if (!valid(editor)) {
          await file.cleanup()
          return
        }
        const pathBytes = Buffer.from(file.path, "utf8")
        inject(editor, pathBytes, { mimeType: "text/plain", kind: "text" })
        const timer = setTimeout(() => cleanup(), 60_000)
        const cleanup = () => {
          clearTimeout(timer)
          cleanups.delete(cleanup)
          return file.cleanup()
        }
        cleanups.add(cleanup)
      } catch {
        await file?.cleanup?.()
        warning(context, "Windows clipboard image could not be pasted")
      }
    }

    function enqueue(editor, fallback) {
      queue = queue.then(() => paste(editor, fallback), () => paste(editor, fallback))
    }

    // Some Windows terminals consume Ctrl+V themselves and send bracketed
    // paste, so the keymap command below never sees the key event.
    const keyInput = context.renderer?.keyInput
    const pasteListener = (event) => {
      if (injecting) return
      const editor = focusedPrompt(context)
      if (!isOpenCodePrompt(editor)) return
      event.preventDefault?.()
      event.stopPropagation?.()
      enqueue(editor, Buffer.from(event.bytes ?? []))
    }
    keyInput?.prependListener?.("paste", pasteListener)

    const unslot = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 1200,
          commands: [{
            id: "custom.wsl-clipboard.paste",
            title: "Paste Windows clipboard",
            bind: "ctrl+v",
            palette: false,
            enabled: () => isOpenCodePrompt(focusedPrompt(context)),
            run: () => {
              const editor = focusedPrompt(context)
              if (!isOpenCodePrompt(editor)) return false
              enqueue(editor)
              return true
            },
          }],
        }))
        return null
      },
    })
    return () => {
      disposed = true
      keyInput?.off?.("paste", pasteListener)
      unslot?.()
      for (const cleanup of cleanups) cleanup()
      cleanups.clear()
    }
  },
})
