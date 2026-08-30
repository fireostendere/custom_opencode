/**
 * Custom model selector plugin for OpenCode TUI.
 *
 * Overrides the built-in `model.list` command (by id) so that the
 * configured keybind (<leader>m), the /models and /mo slash commands and
 * the command palette all open the built-in select dialog filled with a
 * sorted, categorized option list:
 *   Current → Recent → Alibaba → OpenAI → Free → Others
 *
 * The dialog itself is the native `context.ui.dialog.select`, so keyboard
 * navigation, mouse support and filtering work out of the box.
 *
 * Group jumps (Shift+Up / Shift+Down) are layered on top of the native
 * dialog without replacing it: while the dialog is open, a high-priority
 * keymap layer mirrors the navigation keys and programmatically dispatches
 * the dialog's own `dialog.select.*` commands, which lets Shift+Up/Down
 * move the native cursor to the previous/next category. Plain arrows are
 * forwarded one step; Home/End and PageUp/PageDown use bounded multi-step
 * moves so navigation never wraps at either end.
 */
import { Plugin } from "@opencode-ai/plugin/tui"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECENT_LIMIT = 10
const OPENAI_PROVIDERS = new Set(["openai", "chatgpt"])

// Keys that feed the dialog's filter input.  They are mirrored (without
// being consumed) so the jump logic knows when the flat-list model is out
// of sync with the filtered list.
//
// NOTE: the keymap matches letter bindings case-insensitively, so a plain
// lowercase binding already covers lowercase events; keep ONLY the
// `shift+<letter>` variants for shifted input.  Adding uppercase `A`-`Z`
// tokens double-fires every lowercase keystroke and breaks the counter.
const FILTER_KEYS = [
  "backspace",
  "space",
  ..."abcdefghijklmnopqrstuvwxyz0123456789.-_/+:",
  ...Array.from({ length: 26 }, (_, i) => "shift+" + String.fromCharCode(97 + i)),
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {import("@opencode-ai/client").ModelInfo} m */
function key(m) {
  return `${m.providerID}/${m.id}`
}

/**
 * @param {import("@opencode-ai/client").ModelInfo} m
 * @param {Record<string, string>} providerNames
 * @param {string} category
 */
function option(m, providerNames, category) {
  return {
    title: m.name,
    value: { providerID: m.providerID, modelID: m.id },
    description: providerNames[m.providerID] || m.providerID,
    category,
    disabled: m.status === "deprecated",
  }
}

/** @param {{ title: string }} a @param {{ title: string }} b */
function byName(a, b) {
  return a.title.localeCompare(b.title)
}

/**
 * Build the flat, categorized option list in deterministic order:
 * Current (if missing/disabled) → Recent → Alibaba → OpenAI → Free → Others.
 * Within a group models are sorted by name (Others additionally by provider
 * name).
 *
 * @param {import("@opencode-ai/client").ModelInfo[]} models
 * @param {Record<string, string>} providerNames
 * @param {{ providerID: string, modelID: string }[]} recentEntries
 * @param {{ providerID: string, modelID: string } | null} current
 * @returns {import("@opencode-ai/plugin/tui").DialogSelectOption<{ providerID: string, modelID: string }>[]}
 */
function buildOptions(models, providerNames, recentEntries, current) {
  /** @type {import("@opencode-ai/plugin/tui").DialogSelectOption<{ providerID: string, modelID: string }>[]} */
  const options = []
  const seen = new Set()

  // ── Current (kept even when disabled) ──────────────────────────────
  if (current) {
    const curKey = `${current.providerID}/${current.modelID}`
    const covered = models.some((m) => key(m) === curKey && m.enabled)
    if (!covered) {
      const model = models.find((m) => key(m) === curKey)
      if (model) {
        seen.add(curKey)
        options.push(option(model, providerNames, "Current"))
      }
    }
  }

  // ── Recent (recency order) ─────────────────────────────────────────
  for (const r of recentEntries) {
    const model = models.find(
      (m) => m.providerID === r.providerID && m.id === r.modelID,
    )
    if (model && model.enabled && !seen.has(key(model))) {
      seen.add(key(model))
      options.push(option(model, providerNames, "Recent"))
    }
  }

  /**
   * Collect remaining enabled models matching `pred`, sorted.
   * @param {string} category
   * @param {(m: import("@opencode-ai/client").ModelInfo) => boolean} pred
   * @param {(a: { title: string, description: string }, b: { title: string, description: string }) => number} [sortFn]
   */
  const takeSorted = (category, pred, sortFn = byName) => {
    const items = models
      .filter((m) => m.enabled && !seen.has(key(m)) && pred(m))
      .map((m) => {
        seen.add(key(m))
        return option(m, providerNames, category)
      })
      .sort(sortFn)
    options.push(...items)
  }

  // ── Alibaba ─────────────────────────────────────────────────────────
  takeSorted("Alibaba", (m) => m.providerID === "bailian-cli")

  // ── OpenAI ──────────────────────────────────────────────────────────
  takeSorted("OpenAI", (m) => OPENAI_PROVIDERS.has(m.providerID))

  // ── Free (opencode · zero input cost) ───────────────────────────────
  takeSorted(
    "Free",
    (m) => m.providerID === "opencode" && m.cost?.[0]?.input === 0,
  )

  // ── Others ──────────────────────────────────────────────────────────
  takeSorted(
    "Others",
    () => true,
    (a, b) => a.description.localeCompare(b.description) || byName(a, b),
  )

  return options
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "custom.model-selector",
  setup(context) {
    // Persistent recent-model list.
    const [recent, updateRecent] = context.storage.store(
      "model-selector.recent",
      {
        initial: {
          models: /** @type {{ providerID: string, modelID: string }[]} */ ([]),
        },
      },
    )

    // ── Group-jump state ───────────────────────────────────────────────
    // Only meaningful while `open` is true.  `nav` mirrors the dialog's
    // flat navigable list (options minus disabled, in category order),
    // `starts` holds the nav index of each category's first item.
    const jump = {
      open: false,
      nav: /** @type {{ category?: string }[]} */ ([]),
      starts: /** @type {number[]} */ ([]),
      idx: 0,
      currentIdx: 0,
      filterLen: 0,
      moving: false,
      moveToken: 0,
    }

    /**
     * Snapshot the navigable list before opening the dialog.
     * @param {ReturnType<typeof buildOptions>} options
     * @param {{ providerID: string, modelID: string } | null} current
     */
    function beginJump(options, current) {
      const nav = options.filter((o) => !o.disabled)
      /** @type {number[]} */
      const starts = []
      let lastCategory
      nav.forEach((o, i) => {
        if (o.category !== lastCategory) {
          starts.push(i)
          lastCategory = o.category
        }
      })
      let currentIdx = -1
      if (current) {
        currentIdx = nav.findIndex(
          (o) =>
            o.value.providerID === current.providerID &&
            o.value.modelID === current.modelID,
        )
      }
      jump.nav = nav
      jump.starts = starts
      jump.currentIdx = currentIdx >= 0 ? currentIdx : 0
      jump.idx = jump.currentIdx
      jump.filterLen = 0
      jump.moving = false
      jump.open = true
    }

    function resetJump() {
      jump.open = false
      jump.filterLen = 0
      jump.moving = false
      jump.moveToken++
    }

    /** Move one item without wrapping at either end. */
    function stepIdx(delta) {
      const n = jump.nav.length
      if (!n || jump.moving) return false
      const next = jump.idx + delta
      if (next < 0 || next >= n) return false
      jump.idx = next
      return true
    }

    /** Move across multiple items one render tick at a time. */
    function moveTo(target) {
      const n = jump.nav.length
      if (!n || jump.moving) return
      const bounded = Math.max(0, Math.min(n - 1, target))
      const command = bounded < jump.idx ? "dialog.select.prev" : "dialog.select.next"
      let remaining = Math.abs(bounded - jump.idx)
      if (!remaining) return

      const token = ++jump.moveToken
      jump.moving = true
      const step = () => {
        if (!jump.open || token !== jump.moveToken) return
        if (remaining === 0) {
          jump.idx = bounded
          jump.moving = false
          return
        }
        context.keymap.dispatch(command)
        remaining--
        setTimeout(step, 0)
      }
      step()
    }

    /**
     * Move the native cursor to the first item of the next (dir > 0) or
     * previous (dir < 0) category by dispatching the dialog's own
     * prev/next commands.  No-op while a filter is active, because the
     * flat-list model no longer matches the filtered list.
     * @param {1 | -1} dir
     */
    function jumpGroup(dir) {
      const { nav, starts, idx } = jump
      const n = nav.length
      if (!n || starts.length < 2 || jump.filterLen > 0) return

      let target
      if (dir > 0) {
        target = starts.find((s) => s > idx)
        if (target === undefined) return
      } else {
        const atOrBefore = starts.filter((s) => s <= idx)
        target = atOrBefore.length
          ? atOrBefore[atOrBefore.length - 1]
          : undefined
        // Already on a group start → go to the previous group.
        if (target === idx) {
          const earlier = starts.filter((s) => s < idx)
          target = earlier.length
            ? earlier[earlier.length - 1]
            : undefined
        }
        if (target === undefined) return
      }

      moveTo(target)
    }

    /**
     * Mirror filter input (without consuming keys) so jumps can be
     * disabled while filtering and the cursor re-synced once the filter
     * is cleared (the dialog returns the selection to `current` then).
     * @param {string} k
     */
    function filterKey(k) {
      if (!jump.open) return
      if (k === "backspace") {
        if (jump.filterLen > 0) {
          jump.filterLen--
          if (jump.filterLen === 0) jump.idx = jump.currentIdx
        }
        return
      }
      jump.filterLen++
    }

    // Commands forwarded to the native dialog.  While the select dialog is
    // closed every handler returns false so keys fall through untouched.
    const navCommands = [
      {
        id: "model-selector.prev",
        bind: "up",
        run: () => {
          if (!jump.open) return false
          if (jump.filterLen || stepIdx(-1)) {
            context.keymap.dispatch("dialog.select.prev")
          }
        },
      },
      {
        id: "model-selector.next",
        bind: "down",
        run: () => {
          if (!jump.open) return false
          if (jump.filterLen || stepIdx(1)) {
            context.keymap.dispatch("dialog.select.next")
          }
        },
      },
      {
        id: "model-selector.page-up",
        bind: "pageup",
        run: () => {
          if (!jump.open) return false
          if (jump.filterLen) {
            context.keymap.dispatch("dialog.select.page_up")
          } else {
            moveTo(jump.idx - 10)
          }
        },
      },
      {
        id: "model-selector.page-down",
        bind: "pagedown",
        run: () => {
          if (!jump.open) return false
          if (jump.filterLen) {
            context.keymap.dispatch("dialog.select.page_down")
          } else {
            moveTo(jump.idx + 10)
          }
        },
      },
      {
        id: "model-selector.home",
        bind: "home",
        run: () => {
          if (!jump.open) return false
          if (jump.filterLen) return false
          moveTo(0)
        },
      },
      {
        id: "model-selector.end",
        bind: "end",
        run: () => {
          if (!jump.open) return false
          if (jump.filterLen) return false
          moveTo(jump.nav.length - 1)
        },
      },
      {
        id: "model-selector.group-next",
        bind: "shift+down",
        run: () => {
          if (!jump.open) return false
          jumpGroup(1)
        },
      },
      {
        id: "model-selector.group-prev",
        bind: "shift+up",
        run: () => {
          if (!jump.open) return false
          jumpGroup(-1)
        },
      },
    ]

    const filterCommands = FILTER_KEYS.map((k, i) => ({
      id: `model-selector.filter-mirror-${i}`,
      bind: k,
      run: () => {
        filterKey(k)
        return false
      },
    }))

    async function openDialog() {
      const route = context.ui.router.current()
      const sessionID =
        route.type === "session" ? route.sessionID : null

      /** @type {{ providerID: string, modelID: string } | null} */
      let currentModel = null
      if (sessionID) {
        const session = context.data.session.get(sessionID)
        if (session?.model) {
          currentModel = {
            providerID: session.model.providerID,
            modelID: session.model.id,
          }
        }
      }

      const location = context.data.location.default()
      const locDir = { location: { directory: location.directory } }

      /** @type {import("@opencode-ai/client").ModelInfo[]} */
      let models = []
      /** @type {import("@opencode-ai/client").ProviderInfo[]} */
      let providers = []
      try {
        const [modelsRes, providersRes] = await Promise.all([
          context.client.model.list(locDir),
          context.client.provider.list(locDir),
        ])
        models = modelsRes.data ?? []
        providers = providersRes.data ?? []
      } catch {
        context.ui.toast.show({
          message: "Failed to load model list",
          variant: "error",
        })
        return
      }

      if (models.length === 0) {
        context.ui.toast.show({
          message: "No models available",
          variant: "warning",
        })
        return
      }

      /** @type {Record<string, string>} */
      const providerNames = {}
      for (const p of providers) {
        providerNames[p.id] = p.name
      }

      const options = buildOptions(
        models,
        providerNames,
        recent.models,
        currentModel,
      )

      beginJump(options, currentModel)
      /** @type {{ providerID: string, modelID: string } | undefined} */
      let result
      try {
        result = await context.ui.dialog.select({
          title: "Select Model",
          placeholder: "Filter models…",
          options,
          current: currentModel ?? undefined,
        })
      } finally {
        resetJump()
      }
      if (!result || !sessionID) return

      // Persist recent.
      const next = [
        result,
        ...recent.models.filter(
          (r) =>
            !(
              r.providerID === result.providerID &&
              r.modelID === result.modelID
            ),
        ),
      ].slice(0, RECENT_LIMIT)
      try {
        await updateRecent((draft) => {
          draft.models = next
        })
      } catch {
        // Non-fatal.
      }

      // Switch.
      try {
        await context.client.session.switchModel({
          sessionID,
          model: {
            id: result.modelID,
            providerID: result.providerID,
          },
        })
      } catch {
        context.ui.toast.show({
          message: "Failed to switch model",
          variant: "error",
        })
      }
    }

    // `keymap.layer()` may only be created inside a rendered component, so
    // the layers live in an always-mounted headless `app` slot.
    const unslot = context.ui.slot({
      append: "app",
      render: () => {
        // Registered under the built-in `model.list` id so the configured
        // binding (<leader>m) opens this dialog.  `slash` keeps the
        // /models and /mo slash commands working (otherwise the override
        // would shadow the built-in ones).
        context.keymap.layer(() => ({
          mode: "global",
          priority: 200,
          commands: [
            {
              id: "model.list",
              title: "Select Model",
              description:
                "Sorted list: Recent → Alibaba → OpenAI → Free → Others",
              group: "Model",
              slash: { name: "models", aliases: ["mo"] },
              palette: true,
              suggested: true,
              run: () => {
                openDialog()
              },
            },
          ],
        }))

        // Group-jump interception layer.  Always registered; every command
        // passes keys through (`return false`) unless the select dialog is
        // open.  Plain navigation keys are consumed and re-dispatched to
        // the dialog's own commands while the cursor position is tracked.
        context.keymap.layer(() => ({
          mode: "global",
          priority: 900,
          commands: [...navCommands, ...filterCommands],
        }))
        return null
      },
    })

    return () => unslot()
  },
})
