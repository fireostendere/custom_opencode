/**
 * Custom model selector plugin for OpenCode TUI.
 *
 * Overrides the built-in `model.list` command while keeping the native
 * `context.ui.dialog.select` implementation for filtering, keyboard and
 * mouse navigation. Models are grouped deterministically:
 *   Current → Recent → Alibaba → OpenAI → Free → Others
 *
 * Important: do not mirror dialog filter/navigation key events here. The
 * public TUI API does not expose the dialog filter state, so reconstructing
 * it from key presses breaks on paste, IME and Unicode input. Native select
 * owns that state and remains compatible with packaged OpenCode updates.
 */
import { Plugin } from "@opencode-ai/plugin/tui"

const RECENT_LIMIT = 10
const OPENAI_PROVIDERS = new Set(["openai", "chatgpt"])

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

  takeSorted("Alibaba", (model) => model.providerID === "bailian-cli")
  takeSorted("OpenAI", (model) => OPENAI_PROVIDERS.has(model.providerID))
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

    async function openDialog() {
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

      const result = await context.ui.dialog.select({
        title: "Select Model",
        placeholder: "Filter models…",
        options,
        current: currentModel ?? undefined,
      })
      if (!result || !sessionID) return

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
                "Sorted list: Current → Recent → Alibaba → OpenAI → Free → Others",
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
        return null
      },
    })

    return () => unslot()
  },
})
