const WIDTH_KEY = 'custom-opencode:sidebar-width-v1'
const MIN_WIDTH = 240
const MAX_WIDTH = 520
const DEFAULT_WIDTH = 320
const root = document.documentElement
const handle = document.getElementById('sidebarResizer')
const desktopQuery = window.matchMedia('(min-width: 761px)')

function viewportMax() {
  return desktopQuery.matches ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 360)) : MAX_WIDTH
}

function clampWidth(value) {
  return Math.round(Math.max(MIN_WIDTH, Math.min(viewportMax(), Number(value) || DEFAULT_WIDTH)))
}

function setWidth(value, persist = false) {
  const width = clampWidth(value)
  root.style.setProperty('--sidebar-width', `${width}px`)
  handle?.setAttribute('aria-valuenow', String(width))
  handle?.setAttribute('aria-valuemax', String(viewportMax()))
  if (persist) {
    try { localStorage.setItem(WIDTH_KEY, String(width)) } catch {}
  }
}

function storedWidth() {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(value) ? value : DEFAULT_WIDTH
  } catch { return DEFAULT_WIDTH }
}

if (handle) {
  handle.setAttribute('aria-valuemin', String(MIN_WIDTH))
  handle.setAttribute('aria-valuemax', String(MAX_WIDTH))
  setWidth(storedWidth())

  let dragStart = null
  const stopDragging = () => {
    if (!dragStart) return
    dragStart = null
    handle.classList.remove('is-dragging')
    document.body.classList.remove('sidebar-resizing')
  }

  handle.addEventListener('pointerdown', (event) => {
    if (!desktopQuery.matches) return
    event.preventDefault()
    dragStart = { x:event.clientX, width:parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-width')) || DEFAULT_WIDTH }
    handle.classList.add('is-dragging')
    document.body.classList.add('sidebar-resizing')
    handle.setPointerCapture?.(event.pointerId)
  })
  handle.addEventListener('pointermove', (event) => {
    if (dragStart) setWidth(dragStart.width + event.clientX - dragStart.x)
  })
  handle.addEventListener('pointerup', (event) => {
    if (dragStart) setWidth(parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-width')), true)
    handle.releasePointerCapture?.(event.pointerId)
    stopDragging()
  })
  handle.addEventListener('pointercancel', stopDragging)
  handle.addEventListener('keydown', (event) => {
    if (!desktopQuery.matches) return
    const current = parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-width')) || DEFAULT_WIDTH
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      setWidth(current + (event.key === 'ArrowRight' ? 16 : -16), true)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setWidth(event.key === 'End' ? viewportMax() : MIN_WIDTH, true)
    }
  })
  handle.addEventListener('dblclick', () => setWidth(DEFAULT_WIDTH, true))
  window.addEventListener('resize', () => setWidth(parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-width')) || DEFAULT_WIDTH))
  desktopQuery.addEventListener?.('change', () => stopDragging())
}
