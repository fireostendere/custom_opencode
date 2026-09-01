/**
 * Custom model selector plugin for OpenCode TUI.
 *
 * Overrides the built-in `model.list` command while keeping the native
 * `context.ui.dialog.select` implementation for filtering, keyboard and
 * mouse navigation. Models are grouped deterministically:
 *   Current → Favorites → Recent → Alibaba → OpenAI → Orchestrated → Free → Others
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
 * From the home screen (no session) the dialog highlights the last selected
 * model (most recent valid entry of the local recent list) and falls back to
 * the directory default model; choosing a model creates the first session
 * with the selected model and its saved variant.
 */
import { Plugin } from "@opencode-ai/plugin/tui"

const RECENT_LIMIT = 10
const OPENAI_PROVIDERS = new Set(["openai", "chatgpt"])

function modelKey(providerID, modelID) {
  return `${providerID}/${modelID}`
}

function modelVariants(model) {
  if (Array.isArray(model?.variants)) return model.variants
  return Object.entries(model?.variants ?? {}).map(([id, value]) => ({ id, ...value }))
}

async function loadPreferredVariants() {
  try {
    if (!globalThis.Bun?.file) return {}
    const home = typeof process !== "undefined" ? process.env.HOME : ""
    const stateHome = typeof process !== "undefined" && process.env.XDG_STATE_HOME
      ? process.env.XDG_STATE_HOME
      : home
        ? `${home}/.local/state`
        : ""
    if (!stateHome) return {}
    const data = await globalThis.Bun.file(`${stateHome}/opencode/model.json`).json()
    return Object.fromEntries(
      Object.entries(data?.variant ?? {}).filter(
        ([, variant]) => typeof variant === "string" && variant !== "default",
      ),
    )
  } catch {
    return {}
  }
}

function preferredVariant(model, preferences) {
  const candidate =
    preferences[modelKey(model.providerID, model.id)] ??
    preferences[modelKey(model.providerID, model.modelID)]
  return modelVariants(model).some((variant) => variant.id === candidate)
    ? candidate
    : undefined
}

// Role-routed orchestration stacks: provider-pinned worker models plus the
// dedicated Qwen and SOL aliases. Surfaced as their own group so routed
// models stay visible without crowding the provider sections.
const ORCHESTRATED_MODELS = new Set([
  "bailian-cli/qwen3.8-max",
  "bailian-cli/qwen3.8-orchestrated",
  "bailian-cli/qwen3.8-flash",
  "bailian-cli/qwen3.7-plus",
  "bailian-cli/deepseek-v4-pro-0813",
  "bailian-cli/glm-5.2",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-sol-orchestrated",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
])

function key(model) {
  return `${model.providerID}/${model.id}`
}

function option(model, providerNames, category, favorite = false) {
  return {
    title: `${favorite ? "★ " : ""}${model.name}`,
    value: { providerID: model.providerID, modelID: model.id },
    description: providerNames[model.providerID] || model.providerID,
    category,
    disabled: !model.enabled || model.status === "deprecated",
  }
}

function byName(a, b) {
  return a.title.localeCompare(b.title)
}

function buildOptions(models, providerNames, recentEntries, current, favoriteEntries = []) {
  const options = []
  const seen = new Set()
  const categorized = new Set()
  const favoriteKeys = new Set(
    favoriteEntries.map((entry) => `${entry.providerID}/${entry.modelID}`),
  )

  if (current) {
    const currentKey = `${current.providerID}/${current.modelID}`
    const currentModel = models.find((model) => key(model) === currentKey)
    if (currentModel) {
      seen.add(currentKey)
      options.push(option(currentModel, providerNames, "Current", favoriteKeys.has(currentKey)))
    }
  }

  // Disabled favorites stay listed (marked disabled) so they can still be
  // removed via the favorite toggle instead of disappearing silently.
  options.push(
    ...models
      .filter((model) => favoriteKeys.has(key(model)))
      .map((model) => option(model, providerNames, "Favorites", true))
      .sort(byName),
  )

  for (const recent of recentEntries) {
    const model = models.find(
      (item) =>
        item.providerID === recent.providerID &&
        item.id === recent.modelID,
    )
    if (!model || !model.enabled || seen.has(key(model))) continue
    seen.add(key(model))
    options.push(option(model, providerNames, "Recent", favoriteKeys.has(key(model))))
  }

  const takeSorted = (category, predicate, sortFn = byName) => {
    const items = models
      .filter(
        (model) =>
          model.enabled &&
          !categorized.has(key(model)) &&
          (!seen.has(key(model)) || favoriteKeys.has(key(model))) &&
          predicate(model),
      )
      .map((model) => {
        seen.add(key(model))
        categorized.add(key(model))
        return option(model, providerNames, category, favoriteKeys.has(key(model)))
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
    const [favorites, updateFavorites] = context.storage.store(
      "model-selector.favorites",
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
      jump.request = { type: "jump", ...next }
      context.ui.dialog.clear()
    }

    function requestFavorite() {
      if (!jump.active) return false
      jump.request = { type: "favorite" }
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

        let models = []
        let providers = []
        try {
          const [modelsResult, providersResult, preferredVariants] = await Promise.all([
            context.client.model.list(locDir),
            context.client.provider.list(locDir),
            loadPreferredVariants(),
          ])
          models = modelsResult.data ?? []
          providers = providersResult.data ?? []

          jump.preferredVariants = preferredVariants
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

        // Recent entries pointing at models that no longer exist in the
        // catalog (removed provider, stale alias) would otherwise linger
        // forever and skew "last selected" resolution. Drop them.
        const known = new Set(models.map((model) => `${model.providerID}/${model.id}`))
        const validRecent = recent.models.filter((entry) =>
          known.has(`${entry.providerID}/${entry.modelID}`),
        )
        if (validRecent.length !== recent.models.length) {
          Promise.resolve(
            updateRecent((draft) => {
              draft.models = validRecent
            }),
          ).catch(() => {
            // Recent history cleanup is non-critical.
          })
        }

        // From the home screen highlight the last selected model first, then
        // the directory default model.
        if (!currentModel) {
          const lastSelected = validRecent.find((entry) => {
            const model = models.find(
              (item) =>
                item.providerID === entry.providerID &&
                item.id === entry.modelID,
            )
            return Boolean(model?.enabled)
          })
          if (lastSelected) {
            currentModel = {
              providerID: lastSelected.providerID,
              modelID: lastSelected.modelID,
            }
          }
        }
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

        const providerNames = {}
        for (const provider of providers) {
          providerNames[provider.id] = provider.name
        }

        let options = buildOptions(
          models,
          providerNames,
          validRecent,
          currentModel,
          favorites.models,
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
            if (jump.request?.type === "jump") {
              // Shift+Down / Shift+Up: the dialog was cleared by
              // requestJump(); reopen it on the target category.
              current = jump.request.value
              continue
            }
            if (jump.request?.type === "favorite") {
              const favoriteOptions = buildOptions(
                models,
                providerNames,
                [],
                null,
                favorites.models,
              )
                // Dedupe mirrored favorite rows instead of dropping the whole
                // "Favorites" category: a disabled favorite only appears there,
                // and it must remain selectable here to be removable.
                .filter(
                  (item, index, list) =>
                    index ===
                    list.findIndex(
                      (other) =>
                        other.value.providerID === item.value.providerID &&
                        other.value.modelID === item.value.modelID,
                    ),
                )
                .map((item) => ({ ...item, disabled: false }))
              const selectedFavorite = await context.ui.dialog.select({
                title: "Toggle Favorite",
                placeholder: "Filter models…",
                options: favoriteOptions,
                current,
              })
              if (!selectedFavorite) return
              const selectedKey = `${selectedFavorite.providerID}/${selectedFavorite.modelID}`
              const exists = favorites.models.some(
                (entry) => `${entry.providerID}/${entry.modelID}` === selectedKey,
              )
              try {
                await updateFavorites((draft) => {
                  draft.models = exists
                    ? draft.models.filter(
                        (entry) => `${entry.providerID}/${entry.modelID}` !== selectedKey,
                      )
                    : [selectedFavorite, ...draft.models]
                })
              } catch {
                context.ui.toast.show({
                  message: "Failed to update favorites",
                  variant: "error",
                })
                return
              }
              options = buildOptions(
                models,
                providerNames,
                validRecent,
                currentModel,
                favorites.models,
              )
              jump.map = buildCategoryMap(options)
              current = selectedFavorite
              context.ui.toast.show({
                message: exists ? "Removed from Favorites" : "Added to Favorites",
                variant: "success",
              })
              continue
            }
            return // cancelled
          }

          const next = [
            result,
            ...validRecent.filter(
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

          const selected = models.find(
            (item) => item.providerID === result.providerID && item.id === result.modelID,
          )
          const variant = selected && preferredVariant(selected, jump.preferredVariants ?? {})
          const model = {
            id: result.modelID,
            providerID: result.providerID,
            ...(variant ? { variant } : {}),
          }

          try {
            if (!sessionID) {
              // The home composer has no public draft-model setter. Create the
              // session with the selected model so the next prompt uses it.
              const session = await context.client.session.create({
                model,
                location: { directory: location.directory },
              })
              if (!session?.id) throw new Error("Session was not created")
              context.ui.router.navigate({
                type: "session",
                sessionID: session.id,
              })
            } else {
              await context.client.session.switchModel({
                sessionID,
                model,
              })
            }
          } catch {
            context.ui.toast.show({
              message: sessionID
                ? "Failed to switch model"
                : "Failed to create session with selected model",
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
                "Sorted list: Current → Favorites → Recent → Alibaba → OpenAI → Orchestrated → Free → Others; Ctrl+F toggles a favorite; Shift+Down/Up jumps categories",
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
              id: "model-selector.favorite-toggle",
              title: "Model Selector: Toggle Favorite",
              bind: "ctrl+f",
              group: "Model",
              run: requestFavorite,
            },
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
