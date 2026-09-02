function sessionID(value) {
  if (typeof value === "string" && value) return value
  if (value && typeof value === "object") {
    const id = value.id ?? value.sessionID
    if (typeof id === "string" && id) return id
  }
  return null
}

export function resolvePlanSources(cachedTodos, historicalTodos, documentPlan) {
  if (Array.isArray(cachedTodos)) return { todos: cachedTodos, source: "session-todo", document: null }
  if (Array.isArray(historicalTodos)) return { todos: historicalTodos, source: "session-todo", document: null }
  return { todos: documentPlan?.todos ?? [], source: documentPlan?.source, document: documentPlan ?? null }
}

export function selectV2PlanEntries(entries, sessionIDValue) {
  const entriesWithPlans = (entries ?? []).filter((entry) => entry?.isFile?.() && entry.name.endsWith(".md"))
  if (!sessionIDValue) return entriesWithPlans
  return entriesWithPlans.filter((entry) => entry.name === `${sessionIDValue}-plan.md`)
}

export function selectV2PlanCandidates(candidates, sessionIDValue) {
  const scoped = sessionIDValue
    ? (candidates ?? []).filter((candidate) => candidate?.name === `${sessionIDValue}-plan.md`)
    : [...(candidates ?? [])]
  return sessionIDValue ? scoped : scoped.sort((a, b) => Number(b.updated ?? 0) - Number(a.updated ?? 0))
}

export async function syncFamilyMessages(ids, sync) {
  await Promise.all((ids ?? []).map((id) => Promise.resolve().then(() => sync(id)).catch(() => {})))
}

export function resolveRootID(sessionIDValue, root) {
  return sessionID(root) ?? sessionID(sessionIDValue)
}

export function normalizeFamilyIDs(rootID, family) {
  const ids = []
  const add = (value) => {
    const id = sessionID(value)
    if (id && !ids.includes(id)) ids.push(id)
  }
  add(rootID)
  const members = Array.isArray(family) ? family : family?.data ?? []
  for (const member of members) add(member)
  return ids
}
