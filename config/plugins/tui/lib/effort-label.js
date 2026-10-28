// The effort label for the prompt footer. The native prompt line already names the
// selected variant (explicit or saved), so the footer only speaks when it adds
// something: the provider default, a configured effort, or a variant whose effort
// differs from its name.

export function modelKey(providerID, modelID) {
  return `${providerID}/${modelID}`
}

export function variantsOf(model) {
  if (Array.isArray(model?.variants)) return model.variants
  return Object.entries(model?.variants ?? {}).map(([id, value]) => ({ id, ...value }))
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

/** The footer label, or null when it would only repeat the variant the prompt shows. */
export function effortLabel(model, ref, preferred) {
  const saved = preferred[modelKey(ref.providerID, ref.id)] ?? preferred[modelKey(ref.providerID, model?.modelID)]
  const variant =
    ref.variant && ref.variant !== "default"
      ? ref.variant
      : variantsOf(model).some((item) => item.id === saved)
        ? saved
        : undefined
  const label = variantEffort(model, variant) ?? configuredEffort(model) ?? "default"
  return variant && label === variant ? null : label
}
