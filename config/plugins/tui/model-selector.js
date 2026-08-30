/**
 * Custom model selector plugin for OpenCode TUI.
 *
 * Overrides the built-in model.list keybinding with a sorted dialog:
 *   Recent → Alibaba → OpenAI → Free → Others
 *
 * Navigation is non-cycling — the list stops at the first and last item.
 */
import { Plugin } from "@opencode-ai/plugin/tui"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
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

  // ── Recent ──────────────────────────────────────────────────────────
  const recentItems = []
  for (const r of recentEntries) {
    const model = models.find(
      (m) => m.providerID === r.providerID && m.id === r.modelID,
    )
    if (model && model.enabled && !seen.has(key(model))) {
      seen.add(key(model))
      recentItems.push(option(model, providerNames, "Recent"))
    }
  }
  if (recentItems.length > 0) options.push(...recentItems)

  // ── Alibaba ─────────────────────────────────────────────────────────
  const alibaba = models.filter(
    (m) => m.providerID === "bailian-cli" && m.enabled && !seen.has(key(m)),
  )
  for (const m of alibaba) {
    seen.add(key(m))
    options.push(option(m, providerNames, "Alibaba"))
  }

  // ── OpenAI ──────────────────────────────────────────────────────────
  const openai = models.filter(
    (m) => m.providerID === "openai" && m.enabled && !seen.has(key(m)),
  )
  for (const m of openai) {
    seen.add(key(m))
    options.push(option(m, providerNames, "OpenAI"))
  }

  // ── Free (opencode · zero input cost) ───────────────────────────────
  const free = models.filter(
    (m) =>
      m.providerID === "opencode" &&
      m.enabled &&
      !seen.has(key(m)) &&
      m.cost?.[0]?.input === 0,
  )
  for (const m of free) {
    seen.add(key(m))
    options.push(option(m, providerNames, "Free"))
  }

  // ── Others ──────────────────────────────────────────────────────────
  const others = models.filter((m) => m.enabled && !seen.has(key(m)))
  for (const m of others) {
    seen.add(key(m))
    options.push(option(m, providerNames, "Others"))
  }

  // Ensure the current model is always present (even if disabled).
  if (current) {
    const curKey = `${current.providerID}/${current.modelID}`
    if (!seen.has(curKey)) {
      const model = models.find(
        (m) => m.providerID === current.providerID && m.id === current.modelID,
      )
      if (model) {
        options.unshift(option(model, providerNames, "Current"))
      }
    }
  }

  return options
}

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
        initial: { models: /** @type {{ providerID: string, modelID: string }[]} */ ([]) },
      },
    )

    context.keymap.layer(() => ({
      priority: 200,
      commands: [
        {
          bind: "ctrl+p",
          title: "Select Model",
          group: "Model",
          run: async () => {
            const route = context.ui.router.current()
            const sessionID =
              route.type === "session" ? route.sessionID : null

            let currentModel = /** @type {{ providerID: string, modelID: string } | null} */ (null)
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

            let models = /** @type {import("@opencode-ai/client").ModelInfo[]} */ ([])
            let providers = /** @type {import("@opencode-ai/client").ProviderInfo[]} */ ([])
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

            const result = await context.ui.dialog.select({
              title: "Select Model",
              placeholder: "Filter models…",
              options,
              current: currentModel ?? undefined,
            })

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
            ].slice(0, 10)
            await updateRecent((draft) => {
              draft.models = next
            })

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
          },
        },
      ],
    }))
  },
})