/** @jsxImportSource @opentui/solid */
/**
 * Shows the effective TUI effort beside the native prompt footer status.
 * The native footer only renders an explicit variant; this also explains the
 * provider default and the saved per-model variant preference.
 */
import { Plugin } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"

function modelKey(providerID, modelID) {
  return `${providerID}/${modelID}`
}

function variantsOf(model) {
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
    const [preferred, setPreferred] = createSignal({})
    const [models, setModels] = createSignal(
      context.data.location.model.list(location) ?? [],
    )
    const [revision, setRevision] = createSignal(0)
    const unmodel = context.data.on("session.model.selected", () => {
      setRevision((value) => value + 1)
    })

    const [rateLimit, setRateLimit] = createSignal({ active: false, seconds: 0 })
    let lastNotifiedUntil = 0

    const rateLimitTimer = setInterval(async () => {
      try {
        const home = typeof process !== "undefined" ? process.env.HOME : ""
        const stateFile = `${home}/.local/state/custom-opencode/rate-limit.json`
        if (globalThis.Bun?.file) {
          const file = globalThis.Bun.file(stateFile)
          if (await file.exists()) {
            const data = await file.json()
            setRateLimit(data || { active: false, seconds: 0 })
            if (data?.active && data?.until && data.until !== lastNotifiedUntil) {
              lastNotifiedUntil = data.until
              context.ui.toast?.show?.({
                message: `Лимит Gemini (429): ожидание ${data.seconds}с…`,
                variant: "warning",
              })
            }
            return
          }
        }
      } catch {}
      setRateLimit({ active: false, seconds: 0 })
    }, 500)

    loadPreferredVariants().then(setPreferred).catch(() => undefined)
    context.client.model
      .list({ location: { directory: location.directory } })
      .then((response) => setModels(response.data ?? []))
      .catch(() => undefined)

    const unslot = context.ui.slot({
      append: "prompt.footer.status",
      render: ({ sessionID } = {}) => {
        revision()
        const rl = rateLimit()
        if (rl?.active && rl?.seconds > 0) {
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
      clearInterval(rateLimitTimer)
      unmodel()
      unslot()
    }
  },
})
