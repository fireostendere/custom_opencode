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
 * Category jumps (Alt+Down / Alt+Up) are layered on top without
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
import { createEffect } from "solid-js"
import { getNightPromoStatus, isNightDiscountModel } from "./lib/limits-helper.js"
import {
  DND_AGENT,
  LEGACY_AGENT_ALIASES,
  agentForModelChoice,
  modelForAgentSwitch,
  modelRef,
  nextAgent,
  primaryAgents,
  visibleAgent,
} from "./lib/agent-sync.js"

const RECENT_LIMIT = 10
const OPENAI_PROVIDERS = new Set(["openai", "chatgpt"])
const GOOGLE_UNWANTED_MODEL_RE =
  /^(?:veo-|lyria-|gemini-(?:embedding|robotics|omni|2\.5|3-flash-preview|3\.1|3\.5-live)|deep-research-)/i

function isRelevantGoogleModel(model) {
  if (model?.providerID !== "google") return false
  const id = model.id || ""
  if (GOOGLE_UNWANTED_MODEL_RE.test(id)) return false
  if (id.includes("-image") || id.includes("-tts") || id.includes("-live")) return false
  if (id === "gemini-3.5-flash") return false
  return true
}

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
  const variants = modelVariants(model)
  const candidate =
    preferences[modelKey(model.providerID, model.id)] ??
    preferences[modelKey(model.providerID, model.modelID)]
  return variants.some((variant) => variant.id === candidate)
    ? candidate
    : variants.length === 1
      ? variants[0].id
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
  "openai/gpt-6-astra",
  "openai/gpt-6-astra-orchestrated",
  "openai/gpt-6-sol-direct",
  "openai/gpt-6-sol-orchestrated",
  "openai/gpt-6-dnd-edition",
  "openai/gpt-6-luna-direct",
  "openai/gpt-6-luna-reserve",
  "openai/luna-reserve",
])

function key(model) {
  return `${model.providerID}/${model.id}`
}

function option(model, providerNames, category, favorite = false, theme = null, promo = null) {
  const isPromo = isNightDiscountModel(model.id, model.providerID)
  const promoActive = Boolean(promo?.active)
  const promoColor = isPromo
    ? (promoActive
        ? (theme?.text?.feedback?.success?.default || "green")
        : (theme?.text?.feedback?.warning?.default || "yellow"))
    : undefined
  const title = `${favorite ? "★ " : ""}${model.name}`
  return {
    title,
    footer: isPromo ? (promoActive ? "🌙 −50%" : "☀ −50%") : undefined,
    footerColor: promoColor,
    value: { providerID: model.providerID, modelID: model.id },
    description: providerNames[model.providerID] || model.providerID,
    category,
    disabled: !model.enabled || model.status === "deprecated",
  }
}

function byName(a, b) {
  return a.title.localeCompare(b.title)
}

function buildOptions(models, providerNames, recentEntries, current, favoriteEntries = [], theme = null, promo = null) {
  const options = []
  const seen = new Set()
  const categorized = new Set()
  const favoriteKeys = new Set(
    favoriteEntries.map((entry) => `${entry.providerID}/${entry.modelID}`),
  )
  const recentKeys = new Set(
    recentEntries.map((entry) => `${entry.providerID}/${entry.modelID}`),
  )

  if (current) {
    const currentKey = `${current.providerID}/${current.modelID}`
    const currentModel = models.find((model) => key(model) === currentKey)
    if (currentModel) {
      seen.add(currentKey)
      options.push(option(currentModel, providerNames, "Current", favoriteKeys.has(currentKey), theme, promo))
    }
  }

  // Disabled favorites stay listed (marked disabled) so they can still be
  // removed via the favorite toggle instead of disappearing silently.
  options.push(
    ...models
      .filter((model) => favoriteKeys.has(key(model)))
      .map((model) => option(model, providerNames, "Favorites", true, theme, promo))
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
    options.push(option(model, providerNames, "Recent", favoriteKeys.has(key(model)), theme, promo))
  }

  const takeSorted = (category, predicate, sortFn = byName) => {
    const items = models
      .filter(
        (model) =>
          model.enabled &&
          !categorized.has(key(model)) &&
          (!seen.has(key(model)) || favoriteKeys.has(key(model)) || recentKeys.has(key(model))) &&
          predicate(model),
      )
      .map((model) => {
        seen.add(key(model))
        categorized.add(key(model))
        return option(model, providerNames, category, favoriteKeys.has(key(model)), theme, promo)
      })
      .sort(sortFn)
    options.push(...items)
  }

  // Discard unwanted Google models (non-text, legacy versions) so they never spill into Others
  for (const model of models) {
    if (model.providerID === "google" && !isRelevantGoogleModel(model)) {
      seen.add(key(model))
      categorized.add(key(model))
    }
  }

  takeSorted(
    "Alibaba",
    (model) =>
      model.providerID === "bailian-cli" &&
      !ORCHESTRATED_MODELS.has(key(model)),
  )
  takeSorted(
    "OpenAI",
    (model) => OPENAI_PROVIDERS.has(model.providerID) && !ORCHESTRATED_MODELS.has(key(model)),
  )
  takeSorted("Orchestrated", (model) => ORCHESTRATED_MODELS.has(key(model)))
  takeSorted("Google", (model) => isRelevantGoogleModel(model))
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

    // Model a session used before an agent that owns its own model (the D&D
    // narrator) took over; restored when the user leaves that agent again.
    const savedModels = new Map()
    const agentModels = {
      remember(sessionID, model) {
        const ref = modelRef(model)
        if (!sessionID || !ref) return
        savedModels.delete(sessionID)
        savedModels.set(sessionID, ref)
        while (savedModels.size > 64) savedModels.delete(savedModels.keys().next().value)
      },
      peek: (sessionID) => savedModels.get(sessionID),
      forget: (sessionID) => savedModels.delete(sessionID),
    }
    const migrated = new Set()
    let agentSwitching = false

    async function agentsFor(session) {
      const location = session?.location?.directory ? session.location : context.data.location.default()
      const cached = context.data.location.agent?.list?.(location)
      if (Array.isArray(cached) && cached.length) return cached
      try {
        const response = await context.client.agent.list({ location })
        return response?.data ?? []
      } catch {
        return []
      }
    }

    async function withPreferredVariant(model, location) {
      if (!model || model.variant) return model
      try {
        const [response, preferences] = await Promise.all([
          context.client.model.list({ location }),
          loadPreferredVariants(),
        ])
        const entry = (response?.data ?? []).find(
          (item) => item.providerID === model.providerID && item.id === model.id,
        )
        const variant = entry && preferredVariant(entry, preferences)
        return variant ? { ...model, variant } : model
      } catch {
        return model
      }
    }

    // Persist agent switches immediately. The native switch is a TUI-local
    // draft whose model falls back to the config default until the next
    // submit commits it; a persisted agent keeps the session's model.
    async function switchSessionAgent(sessionID, target, agents) {
      const session = context.data.session.get(sessionID)
      if (!session || !target || target.id === session.agent) return
      const from = visibleAgent(agents, session.agent)
      const remembered = agentModels.peek(sessionID)
      let model = modelForAgentSwitch({
        from,
        to: target,
        sessionModel: session.model,
        remembered,
        recent: recent.models,
        agents,
      })
      if (model && target.model) agentModels.remember(sessionID, session.model)
      model = await withPreferredVariant(model, session.location)
      await context.client.session.switchAgent({ sessionID, agent: target.id })
      if (model) {
        await context.client.session.switchModel({ sessionID, model })
        if (!target.model) agentModels.forget(sessionID)
      }
      context.ui.toast.show({
        message: `Agent: ${target.name || target.id}`,
        variant: "info",
        duration: 1500,
      })
    }

    function sessionAgentAction(pick) {
      const route = context.ui.router.current()
      // Home and busy sessions keep the native draft behaviour: the home
      // prompt has no session to persist to and a running turn must not
      // change agent mid-flight.
      if (route?.type !== "session") return false
      const sessionID = route.sessionID
      const session = context.data.session.get(sessionID)
      if (!session || context.data.session.status(sessionID) === "running") return false
      if (agentSwitching) return
      agentSwitching = true
      void (async () => {
        try {
          const agents = await agentsFor(session)
          const target = await pick(agents, session)
          if (target) await switchSessionAgent(sessionID, target, agents)
        } catch {
          context.ui.toast.show({ message: "Failed to switch agent", variant: "error" })
        } finally {
          agentSwitching = false
        }
      })()
    }

    const cycleAgent = (direction) =>
      sessionAgentAction((agents, session) => nextAgent(agents, session.agent, direction))

    const chooseAgent = () =>
      sessionAgentAction(async (agents, session) => {
        const visible = primaryAgents(agents)
        const selected = await context.ui.dialog.select({
          title: "Select Agent",
          placeholder: "Filter agents…",
          options: visible.map((agent) => ({
            title: agent.name || agent.id,
            value: agent.id,
            description: agent.description,
          })),
          current: visibleAgent(visible, session.agent)?.id,
        })
        return visible.find((agent) => agent.id === selected)
      })

    // Sessions saved under a hidden legacy agent render with the config
    // default model in the native TUI. Migrate them once, preserving the model.
    function migrateLegacyAgent() {
      const route = context.ui.router.current()
      if (route?.type !== "session") return
      const sessionID = route.sessionID
      const session = context.data.session.get(sessionID)
      const target = LEGACY_AGENT_ALIASES[session?.agent]
      if (!target || session.parentID || migrated.has(sessionID)) return
      if (context.data.session.status(sessionID) !== "idle") return
      migrated.add(sessionID)
      Promise.resolve(context.client.session.switchAgent({ sessionID, agent: target })).catch(() => {
        // Leave the session as is; choosing a model migrates it as well.
      })
    }

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

        const promo = getNightPromoStatus()

        let options = buildOptions(
          models,
          providerNames,
          validRecent,
          currentModel,
          favorites.models,
          context.theme,
          promo,
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
              // Alt+Down / Alt+Up: the dialog was cleared by
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
                context.theme,
                promo,
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
                context.theme,
                promo,
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

          const selected = models.find(
            (item) => item.providerID === result.providerID && item.id === result.modelID,
          )
          const variant = selected && preferredVariant(selected, jump.preferredVariants ?? {})
          const model = {
            id: result.modelID,
            providerID: result.providerID,
            ...(variant ? { variant } : {}),
          }
          const session = sessionID ? context.data.session.get(sessionID) : null
          // The TUI honours a session's model only under a visible agent that
          // matches it: D&D needs the narrator, leaving D&D needs Build, and
          // hidden legacy agents must migrate or the model silently resets.
          const agent = agentForModelChoice(model, session?.agent)
          let agentChanged = false

          try {
            if (!sessionID) {
              // The home composer has no public draft-model setter. Create the
              // session with the selected model so the next prompt uses it.
              const session = await context.client.session.create({
                model,
                ...(agent === DND_AGENT ? { agent } : {}),
                location: { directory: location.directory },
              })
              if (!session?.id) throw new Error("Session was not created")
              context.ui.router.navigate({
                type: "session",
                sessionID: session.id,
              })
            } else {
              if (agent && agent !== session?.agent) {
                await context.client.session.switchAgent({ sessionID, agent })
                agentChanged = true
              }
              await context.client.session.switchModel({
                sessionID,
                model,
              })
              agentModels.forget(sessionID)
            }
            try {
              await updateRecent((draft) => {
                const currentRecent = Array.isArray(draft.models) ? draft.models : []
                draft.models = [
                  result,
                  ...currentRecent.filter(
                    (entry) =>
                      !(entry.providerID === result.providerID && entry.modelID === result.modelID),
                  ),
                ].slice(0, RECENT_LIMIT)
              })
            } catch {
              // Recent history is non-critical.
            }
          } catch {
            if (agentChanged && session?.agent) {
              try {
                await context.client.session.switchAgent({ sessionID, agent: session.agent })
              } catch {
                // The original failure is reported below.
              }
            }
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
        createEffect(migrateLegacyAgent)
        context.keymap.layer(() => ({
          mode: "global",
          priority: 200,
          commands: [
            {
              id: "model.list",
              title: "Select Model",
              description:
                "Sorted list: Current → Favorites → Recent → Alibaba → OpenAI → Orchestrated → Google → Free → Others; Ctrl+F toggles a favorite; Alt+Down/Up jumps categories",
              group: "Model",
              slash: { name: "models", aliases: ["mo"] },
              palette: true,
              suggested: true,
              run: () => {
                openDialog()
              },
            },
            // Same IDs as the native agent commands, so their configured
            // bindings (shift+tab, <leader>a, /agents) reach these handlers.
            {
              id: "agent.cycle",
              title: "Agent cycle",
              description: "Next agent; keeps the session's model",
              group: "Agent",
              run: () => cycleAgent(1),
            },
            {
              id: "agent.cycle.reverse",
              title: "Agent cycle reverse",
              description: "Previous agent; keeps the session's model",
              group: "Agent",
              run: () => cycleAgent(-1),
            },
            {
              id: "agent.list",
              title: "Switch agent",
              description: "Choose an agent; keeps the session's model",
              group: "Agent",
              slash: { name: "agents" },
              palette: true,
              run: () => chooseAgent(),
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
              bind: "alt+down",
              group: "Model",
              run: () => {
                if (!jump.active) return false
                requestJump(1)
              },
            },
            {
              id: "model-selector.group-prev",
              title: "Model Selector: Previous Category",
              bind: "alt+up",
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
