/**
 * Custom model selector plugin for OpenCode TUI.
 *
 * Overrides the built-in `model.list` command while keeping the native
 * `context.ui.dialog.select` implementation for filtering, keyboard and
 * mouse navigation. Models are grouped deterministically:
 *   Current → Recent → Alibaba → OpenAI → Orchestrated → Free → Others
 * "Orchestrated" is the provider-pinned role routing stack (see
 * ORCHESTRATED_MODELS), kept separate from the remaining Alibaba models.
 *
 * Category jumps (Shift+Down / Shift+Up) are layered on top without
 * mirroring any dialog key events. The public TUI API does not expose the
 * dialog filter or cursor state, so instead of tracking the cursor the
 * jump closes the dialog (`ui.dialog.clear`) and reopens it with
 * `current` set to the first model of the next/previous category.
 * Reopening also resets the filter, which keeps jumps deterministic.
 * Categories wrap around: Recent → Alibaba → OpenAI → Orchestrated →
 * Free → Others → Recent (empty categories are skipped, "Current" is
 * never a jump target).
 *
 * From the home screen (no session) the dialog highlights the directory
 * default model, and choosing a model shows a toast instead of switching,
 * because there is no session to switch.
 */
import { Plugin } from "@opencode-ai/plugin/tui"

const RECENT_LIMIT = 10
const OPENAI_PROVIDERS = new Set(["openai", "chatgpt"])

// Role-routed orchestration stack (docs/model-routing-effort.md): the
// provider-pinned planner/builder/reader/reviewer/long-horizon models plus
// the dedicated `qwen3.8-orchestrated` alias. Surfaced as their own group so
// the routed models stay visible without crowding the OpenAI section.
const ORCHESTRATED_MODELS = new Set([
  "bailian-cli/qwen3.8-max",
  "bailian-cli/qwen3.8-orchestrated",
  "bailian-cli/qwen3.8-flash",
  "bailian-cli/qwen3.7-plus",
  "bailian-cli/deepseek-v4-pro-0813",
  "bailian-cli/glm-5.2",
])

function key(model) {
  return `${model.providerID}/${model.id}`
}

function option(model, providerNames, category) {
  return {
    title: model.name,
    value: { providerID: model.providerID, modelID: model.id },
    description: providerNames[model.providerID] || model.providerID,
    category,
    disabled: model.status === "deprecated",
  }
}

function byName(a, b) {
  return a.title.localeCompare(b.title)
}

function buildOptions(models, providerNames, recentEntries, current) {
  const options = []
  const seen = new Set()

  if (current) {
    const currentKey = `${current.providerID}/${current.modelID}`
    const currentModel = models.find((model) => key(model) === currentKey)
    if (currentModel) {
      seen.add(currentKey)
      options.push(option(currentModel, providerNames, "Current"))
    }
  }

  for (const recent of recentEntries) {
    const model = models.find(
      (item) =>
        item.providerID === recent.providerID &&
        item.id === recent.modelID,
    )
    if (!model || !model.enabled || seen.has(key(model))) continue
    seen.add(key(model))
    options.push(option(model, providerNames, "Recent"))
  }

  const takeSorted = (category, predicate, sortFn = byName) => {
    const items = models
      .filter(
        (model) =>
          model.enabled &&
          !seen.has(key(model)) &&
          predicate(model),
      )
      .map((model) => {
        seen.add(key(model))
        return option(model, providerNames, category)
      })
      .sort(sortFn)
    options.push(...items)
  }

  takeSorted(
    "Alibaba",
    (model) =>
      model.providerID === "bailian-cli" &&
      !ORCHESTRATED_MODELS.has(key(model)),
  )
  takeSorted("OpenAI", (model) => OPENAI_PROVIDERS.has(model.providerID))
  takeSorted("Orchestrated", (model) => ORCHESTRATED_MODELS.has(key(model)))
  takeSorted(
    "Free",
    (model) => model.providerID === "opencode" && model.cost?.[0]?.input === 0,
  )
  takeSorted(
    "Others",
    () => true,
    (a, b) => a.description.localeCompare(b.description) || byName(a, b),
  )

  return options
}

/**
 * Jump targets in display order: the first navigable option of every
 * category except "Current" (a single-item anchor, not a section).
 * @param {ReturnType<typeof buildOptions>} options
 */
function buildCategoryMap(options) {
  const map = []
  const seen = new Set()
  for (const item of options) {
    if (item.disabled || !item.category || seen.has(item.category)) continue
    seen.add(item.category)
    if (item.category === "Current") continue
    map.push({ category: item.category, value: item.value })
  }
  return map
}

/**
 * @param {ReturnType<typeof buildOptions>} options
 * @param {{ providerID: string, modelID: string } | undefined} value
 */
function categoryOf(options, value) {
  if (!value) return null
  const item = options.find(
    (entry) =>
      entry.value.providerID === value.providerID &&
      entry.value.modelID === value.modelID,
  )
  return item?.category ?? null
}

export default Plugin.define({
  id: "custom.model-selector",
  setup(context) {
    const [recent, updateRecent] = context.storage.store(
      "model-selector.recent",
      {
        initial: {
          models: [],
        },
      },
    )

    // Shared state between openDialog() and the jump keymap layer.
    const jump = {
      active: false,
      map: [],
      currentCategory: null,
      request: null,
    }

    /**
     * Ask the dialog to reopen on the first model of the next (dir > 0) or
     * previous (dir < 0) category. Wraps around; no-op with fewer than two
     * categories.
     * @param {1 | -1} dir
     */
    function requestJump(dir) {
      if (!jump.active || jump.map.length === 0) return
      const idx = jump.map.findIndex(
        (hop) => hop.category === jump.currentCategory,
      )
      let next
      if (jump.map.length === 1) {
        if (idx !== -1) return
        next = jump.map[0]
      } else if (idx === -1) {
        // Unknown/anchor category: start from the edge.
        next = dir > 0 ? jump.map[0] : jump.map[jump.map.length - 1]
      } else {
        next = jump.map[(idx + dir + jump.map.length) % jump.map.length]
      }
      jump.request = next
      context.ui.dialog.clear()
    }

    async function openDialog() {
      if (jump.active) return
      jump.active = true

      try {
        const route = context.ui.router.current()
        const sessionID = route.type === "session" ? route.sessionID : null

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

        // From the home screen highlight the directory default model.
        if (!currentModel) {
          try {
            const def = await context.client.model.default(locDir)
            if (def?.data?.providerID && def.data.id) {
              currentModel = {
                providerID: def.data.providerID,
                modelID: def.data.id,
              }
            }
          } catch {
            // Highlight is optional.
          }
        }

        let models = []
        let providers = []
        try {
          const [modelsResult, providersResult] = await Promise.all([
            context.client.model.list(locDir),
            context.client.provider.list(locDir),
          ])
          models = modelsResult.data ?? []
          providers = providersResult.data ?? []
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

        const providerNames = {}
        for (const provider of providers) {
          providerNames[provider.id] = provider.name
        }

        const options = buildOptions(
          models,
          providerNames,
          recent.models,
          currentModel,
        )

        jump.map = buildCategoryMap(options)

        let current = currentModel ?? undefined
        while (true) {
          jump.request = null
          jump.currentCategory = categoryOf(options, current)
          const result = await context.ui.dialog.select({
            title: "Select Model",
            placeholder: "Filter models…",
            options,
            current,
          })
          if (!result) {
            if (jump.request) {
              // Shift+Down / Shift+Up: the dialog was cleared by
              // requestJump(); reopen it on the target category.
              current = jump.request.value
              continue
            }
            return // cancelled
          }

          const next = [
            result,
            ...recent.models.filter(
              (entry) =>
                !(
                  entry.providerID === result.providerID &&
                  entry.modelID === result.modelID
                ),
            ),
          ].slice(0, RECENT_LIMIT)

          try {
            await updateRecent((draft) => {
              draft.models = next
            })
          } catch {
            // Recent history is non-critical.
          }

          if (!sessionID) {
            context.ui.toast.show({
              message: "Open a session to switch models",
              variant: "warning",
            })
            return
          }

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
          return
        }
      } finally {
        jump.active = false
        jump.request = null
        jump.currentCategory = null
      }
    }

    const unslot = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 200,
          commands: [
            {
              id: "model.list",
              title: "Select Model",
              description:
                "Sorted list: Current → Recent → Alibaba → OpenAI → Orchestrated → Free → Others; Shift+Down/Up jumps categories",
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

        // Category-jump layer. Active only while the select dialog is open;
        // otherwise both commands return false and let the keys through.
        // Jumps do not mirror dialog key events: they close the dialog and
        // reopen it on the target category (see requestJump/openDialog).
        context.keymap.layer(() => ({
          mode: "global",
          priority: 900,
          commands: [
            {
              id: "model-selector.group-next",
              title: "Model Selector: Next Category",
              bind: "shift+down",
              group: "Model",
              run: () => {
                if (!jump.active) return false
                requestJump(1)
              },
            },
            {
              id: "model-selector.group-prev",
              title: "Model Selector: Previous Category",
              bind: "shift+up",
              group: "Model",
              run: () => {
                if (!jump.active) return false
                requestJump(-1)
              },
            },
          ],
        }))
        return null
      },
    })

    return () => unslot()
  },
})
