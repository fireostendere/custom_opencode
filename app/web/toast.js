// The one toast every module shows: same element, same timing.
export function toast(text, ms = 3200) {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = text
  el.hidden = false
  clearTimeout(el._timer)
  el._timer = setTimeout(() => { el.hidden = true }, ms)
}
