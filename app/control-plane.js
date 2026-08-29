import * as api from './api.js'

let lastPermissionKey = ''
let inFlight = false
let timer = null

function sessionIDFromHash() {
  const match = /^#\/session\/([^/?]+)/.exec(location.hash)
  return match ? decodeURIComponent(match[1]) : null
}

async function currentSession(sessionID) {
  const value = api.dataOf(await api.request(`/api/session/${encodeURIComponent(sessionID)}`))
  return value && typeof value === 'object' ? value : null
}

async function evaluatePendingPermission() {
  if (inFlight || document.hidden) return
  const sessionID = sessionIDFromHash()
  if (!sessionID) {
    lastPermissionKey = ''
    return
  }

  inFlight = true
  try {
    const session = await currentSession(sessionID)
    const directory = session?.location?.directory
    if (!directory) return
    const requests = await api.getPermissions(directory)
    const pending = requests.find((request) => request?.sessionID === sessionID)
    if (!pending?.id) {
      lastPermissionKey = ''
      return
    }

    const key = `${sessionID}:${pending.id}`
    if (key === lastPermissionKey) return
    lastPermissionKey = key

    const result = await api.evaluatePermission(sessionID, String(pending.id))
    if (result?.autoReplied || result?.stale) {
      const banner = document.getElementById('permissionBanner')
      if (banner) banner.hidden = true
      lastPermissionKey = ''
    }
  } catch (error) {
    // Policy failures intentionally fail closed to the normal interactive card.
    console.warn('Control-plane permission evaluation failed', error)
  } finally {
    inFlight = false
  }
}

async function loadControlPlaneStatus() {
  try {
    const status = await api.getControlPlane()
    const policy = status?.permissionPolicy
    if (policy?.preset) document.documentElement.dataset.permissionPolicy = policy.preset
    if (status?.controlPlaneVersion) document.documentElement.dataset.controlPlaneVersion = String(status.controlPlaneVersion)
  } catch (error) {
    console.warn('Control-plane status unavailable', error)
  }
}

function schedule() {
  clearInterval(timer)
  timer = setInterval(evaluatePendingPermission, 900)
}

window.addEventListener('hashchange', () => {
  lastPermissionKey = ''
  evaluatePendingPermission()
})
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) evaluatePendingPermission()
})

loadControlPlaneStatus()
schedule()
evaluatePendingPermission()
