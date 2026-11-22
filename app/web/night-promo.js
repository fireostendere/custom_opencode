// Bailian night discount: 22:00–08:00 Beijing time, on these models only.
const MODELS = new Set([
  'qwen3.8-max',
  'qwen3.8-orchestrated',
  'qwen3.8-max-preview',
  'deepseek-v4-pro-0813',
  'deepseek-v4-flash-0731',
])

export function isNightPromoActive(nowMs = Date.now()) {
  const bj = new Date(nowMs + 8 * 3600 * 1000)
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  return min >= 22 * 60 || min < 8 * 60
}

export function isNightPromoModel(modelID, providerID) {
  if (providerID && providerID !== 'bailian-cli') return false
  return MODELS.has(modelID)
}

export const promoBadgeText = (active) => (active ? '−50% сейчас' : '−50% ночью')
