const $ = (id) => document.getElementById(id)

let inFlight = false
let lastAttemptKey = ''
let lastAttemptAt = 0

function sessionID() {
  const match = /^#\/session\/([^/?]+)/.exec(location.hash || '')
  return match ? decodeURIComponent(match[1]) : null
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type':'application/json', ...(options.headers || {}) },
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.status === 204 ? null : response.json()
}

function ensureRiskSurface() {
  const text = document.querySelector('#permissionBanner .permission-text')
  if (!text) return null
  let row = $('permissionRisk')
  if (!row) {
    row = document.createElement('div')
    row.id = 'permissionRisk'
    row.className = 'permission-risk-row'
    row.hidden = true
    row.innerHTML = '<span class="permission-risk-badge"></span><span class="permission-risk-reason"></span>'
    text.append(row)
  }
  return row
}

function hideRiskSurface() {
  const row = ensureRiskSurface()
  if (row) row.hidden = true
}

function renderDecision(decision) {
  const row = ensureRiskSurface()
  if (!row) return
  const risk = typeof decision?.risk === 'string' ? decision.risk : ''
  if (!risk) {
    row.hidden = true
    return
  }
  row.hidden = false
  row.dataset.risk = risk
  row.querySelector('.permission-risk-badge').textContent = risk
  row.querySelector('.permission-risk-reason').textContent = decision.reason || ''

  const summary = $('permissionSummary')
  if (summary && typeof decision?.preview === 'string' && decision.preview.trim()) {
    summary.textContent = decision.preview.trim()
    summary.dataset.serverPreview = '1'
  }

  const projectAllow = document.querySelector('#permissionBanner .permission-project-button')
  if (projectAllow) {
    const hard = risk === 'R3' || risk === 'R4'
    projectAllow.disabled = hard
    projectAllow.title = hard
      ? `${risk}: project auto-allow не может обойти обязательное подтверждение`
      : 'Сохранить ограниченное auto-allow правило для этого проекта'
  }
}

async function autoEvaluate(sid, decision) {
  if (!decision?.auto || !decision?.permissionID || inFlight) return
  const key = `${sid}:${decision.permissionID}`
  const now = Date.now()
  if (key === lastAttemptKey && now - lastAttemptAt < 3000) return
  lastAttemptKey = key
  lastAttemptAt = now
  inFlight = true
  try {
    const result = await request('/client-permission-evaluate.json', {
      method:'POST',
      body:JSON.stringify({ sessionID:sid, permissionID:decision.permissionID }),
    })
    if (result?.autoReplied) {
      const permissionBanner = $('permissionBanner')
      if (permissionBanner && permissionBanner.dataset.permissionSession === sid && permissionBanner.dataset.permissionId === String(decision.permissionID)) permissionBanner.hidden = true
      hideRiskSurface()
      window.__permissionSuppression?.markResolved(key)
    }
  } catch (error) {
    console.warn('permission auto-evaluate failed', error)
  } finally {
    inFlight = false
  }
}

async function tick() {
  if (document.hidden) return
  const sid = sessionID()
  const permissionBanner = $('permissionBanner')
  if (!sid || !permissionBanner || permissionBanner.hidden) {
    hideRiskSurface()
    return
  }
  try {
    const decision = await request(`/client-permission-risk.json?sessionID=${encodeURIComponent(sid)}`)
    if (decision?.stale || !decision?.risk) {
      hideRiskSurface()
      return
    }
    renderDecision(decision)
    await autoEvaluate(sid, decision)
  } catch {
    // Fail closed: normal native permission UI remains usable when the helper
    // endpoint is unavailable or the backend is restarting.
  }
}

window.addEventListener('hashchange', () => { lastAttemptKey = ''; tick() })
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick() })
const permissionBanner = $('permissionBanner')
if (permissionBanner) new MutationObserver(tick).observe(permissionBanner, { attributes:true, attributeFilter:['hidden'] })
setInterval(tick, 800)
tick()
