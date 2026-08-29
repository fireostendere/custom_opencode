const $ = (id) => document.getElementById(id)
let running = false

function toast(text, ms = 4000) {
  const el = $('toast')
  if (!el) return
  el.textContent = text
  el.hidden = false
  clearTimeout(el._ragTimer)
  el._ragTimer = setTimeout(() => { el.hidden = true }, ms)
}

function sessionIdFromHash() {
  const match = /^#\/session\/([^/?]+)/.exec(location.hash)
  return match ? decodeURIComponent(match[1]) : null
}

export function parseRagStart(value) {
  const match = /^\/rag-start(?:\s+(quick|full))?\s*$/i.exec(String(value || ''))
  return match ? { mode: (match[1] || 'full').toLowerCase() } : null
}

function summary(result) {
  const registry = result?.runtime?.registry || {}
  const qdrant = result?.runtime?.qdrant?.qdrant || {}
  const docs = Number(registry.documents || 0)
  const chunks = Number(registry.chunks || 0)
  const points = qdrant.indexedPoints
  const action = result?.mcp?.action || 'unknown'
  return `RAG готов · ${docs} docs · ${chunks} chunks${Number.isFinite(points) ? ` · ${points} points` : ''} · MCP ${action}`
}

async function startRag(mode) {
  if (running) {
    toast('RAG start/check уже выполняется', 5000)
    return
  }
  running = true
  toast(mode === 'quick' ? 'RAG: быстрая проверка и подключение…' : 'RAG: запуск, retrieval-проверка и подключение…', 8000)
  try {
    const response = await fetch('/client-rag-start.json', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ mode, sessionID: sessionIdFromHash() }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body?.error || `${response.status} ${response.statusText}`)
    if (!body?.ok) {
      const detail = body?.error || body?.runtime?.error || body?.mcp?.error || body?.stage || 'RAG не готов'
      toast(`RAG: ${detail}`, 9000)
      window.dispatchEvent(new CustomEvent('custom-opencode:doctor'))
      return
    }
    toast(summary(body), 7000)
    window.dispatchEvent(new CustomEvent('custom-opencode:doctor'))
  } catch (error) {
    toast(`RAG start: ${error.message}`, 9000)
  } finally {
    running = false
  }
}

function slashToken(input) {
  const value = input.value || ''
  if (!value.startsWith('/') || value.startsWith('//')) return null
  return value.slice(1).split(/\s/, 1)[0].toLowerCase()
}

function injectSlashSuggestion() {
  const input = $('input')
  const palette = $('slashPalette')
  if (!input || !palette) return
  const token = slashToken(input)
  if (token === null || !'rag-start'.startsWith(token)) return
  if (palette.querySelector('[data-rag-start]')) return

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'slash-item'
  button.dataset.ragStart = '1'
  button.innerHTML = '<span class="slash-name">/rag-start</span><span class="slash-desc">Проверить/поднять RAG, сделать local retrieval smoke и подключить kb MCP · quick/full</span>'
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    input.value = '/rag-start '
    input.dispatchEvent(new Event('input', { bubbles:true }))
    input.focus()
    palette.hidden = true
  })
  palette.prepend(button)
  palette.hidden = false
}

function bind() {
  const form = $('form')
  const input = $('input')
  const palette = $('slashPalette')
  if (!form || !input) return

  form.addEventListener('submit', (event) => {
    const parsed = parseRagStart(input.value.trim())
    if (!parsed) return
    event.preventDefault()
    event.stopImmediatePropagation()
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles:true }))
    void startRag(parsed.mode)
  }, true)

  if (palette) {
    const observer = new MutationObserver(() => queueMicrotask(injectSlashSuggestion))
    observer.observe(palette, { childList:true, subtree:false })
    input.addEventListener('input', () => setTimeout(injectSlashSuggestion, 0))
  }
}

if (typeof document !== 'undefined') bind()
