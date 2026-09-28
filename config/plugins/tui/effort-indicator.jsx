/** @jsxImportSource @opentui/solid */
/**
 * Shows the effective TUI effort beside the native prompt footer status.
 * The native footer only renders an explicit variant; this also explains the
 * provider default and the saved per-model variant preference.
 *
 * The footer render re-runs whenever a signal it reads changes, so every
 * signal here is equality-checked: an unchanged poll result must not rebuild
 * the prompt footer.
 */
import { Plugin } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import { INACTIVE_RATE_LIMIT, sameRateLimit, watchRateLimit } from "./lib/limits-helper.js"

const MODEL_RELOAD_DEBOUNCE_MS = 500
const MISSING_MODEL_RELOAD_MS = 30_000

function modelKey(providerID, modelID) {
  return `${providerID}/${modelID}`
}

function variantsOf(model) {
  if (Array.isArray(model?.variants)) return model.variants
  return Object.entries(model?.variants ?? {}).map(([id, value]) => ({ id, ...value }))
}

function samePreferences(a, b) {
  if (a === b) return true
  const left = Object.keys(a ?? {})
  if (left.length !== Object.keys(b ?? {}).length) return false
  return left.every((key) => a[key] === b?.[key])
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

function configuredEffort(model) {
  const settings = model?.settings ?? {}
  return settings.effort ?? settings.reasoningEffort ?? null
}

function variantEffort(model, id) {
  if (!id || id === "default") return null
  const variant = variantsOf(model).find((item) => item.id === id)
  const settings = variant?.settings ?? {}
  return settings.effort ?? settings.reasoningEffort ?? id
}

export default Plugin.define({
  id: "custom.effort-indicator",
  setup(context) {
    const location = context.location ?? context.data.location.default()
    let disposed = false
    const [preferred, setPreferred] = createSignal({}, { equals: samePreferences })
    const [models, setModels] = createSignal(
      context.data.location.model.list(location) ?? [],
    )
    const [revision, setRevision] = createSignal(0)
    const [rateLimit, setRateLimit] = createSignal(INACTIVE_RATE_LIMIT, { equals: sameRateLimit })

    function reloadPreferences() {
      loadPreferredVariants().then((value) => {
        if (!disposed) setPreferred(value)
      }).catch(() => undefined)
    }

    let modelReload = null
    let lastMissingReload = 0
    function reloadModels() {
      context.client.model
        .list({ location: { directory: location.directory } })
        .then((response) => {
          if (!disposed && Array.isArray(response?.data)) setModels(response.data)
        })
        .catch(() => undefined)
    }
    function scheduleModelReload() {
      if (disposed || modelReload) return
      modelReload = setTimeout(() => {
        modelReload = null
        reloadModels()
      }, MODEL_RELOAD_DEBOUNCE_MS)
      modelReload.unref?.()
    }

    const unsubscribers = []
    function subscribe(type, handler) {
      try {
        const unsubscribe = context.data.on(type, handler)
        if (typeof unsubscribe === "function") unsubscribers.push(unsubscribe)
      } catch {}
    }
    // A model/variant choice is persisted to model.json by the native picker.
    subscribe("session.model.selected", () => {
      setRevision((value) => value + 1)
      reloadPreferences()
    })
    subscribe("catalog.updated", scheduleModelReload)

    let lastNotifiedUntil = 0
    const stopRateLimit = watchRateLimit((next) => {
      setRateLimit(next)
      if (next.active && next.until && next.until !== lastNotifiedUntil) {
        lastNotifiedUntil = next.until
        context.ui.toast?.show?.({
          message: `Лимит Gemini (429): ожидание ${next.seconds}с…`,
          variant: "warning",
        })
      }
    })

    reloadPreferences()
    reloadModels()

    const unslot = context.ui.slot({
      append: "prompt.footer.status",
      render: ({ sessionID } = {}) => {
        revision()
        const rl = rateLimit()
        if (rl.active && rl.seconds > 0) {
          return (
            <text fg={context.theme.warning || "yellow"}>
              ⏳ Лимит Gemini: повтор через {rl.seconds}с
            </text>
          )
        }
        if (!sessionID) return null
        const session = context.data.session.get(sessionID)
        const ref = session?.model
        if (!ref) return null

        const model = models().find(
          (item) =>
            item.providerID === ref.providerID &&
            (item.id === ref.id || item.modelID === ref.id),
        )
        if (!model && Date.now() - lastMissingReload > MISSING_MODEL_RELOAD_MS) {
          // A model added after startup: refresh the list once in a while.
          lastMissingReload = Date.now()
          scheduleModelReload()
        }
        const explicit = variantEffort(model, ref.variant)
        const saved =
          preferred()[modelKey(ref.providerID, ref.id)] ??
          preferred()[modelKey(ref.providerID, model?.modelID)]
        const savedVariant = variantsOf(model).some((variant) => variant.id === saved)
          ? variantEffort(model, saved)
          : null
        const label = explicit ?? savedVariant ?? configuredEffort(model) ?? "default"
        return <text fg={context.theme.text.subdued}>Effort: {label}</text>
      },
    })

    return () => {
      disposed = true
      stopRateLimit()
      if (modelReload) clearTimeout(modelReload)
      modelReload = null
      for (const unsubscribe of unsubscribers) unsubscribe()
      unslot()
    }
  },
})
