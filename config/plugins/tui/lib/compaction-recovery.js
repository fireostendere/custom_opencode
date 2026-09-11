// The pinned native engine can retain interrupted compactions as running.
// A later assistant step or compaction in the same serial session proves that
// the old operation is no longer active. Recover only the TUI read model.
export function installCompactionRecovery(context) {
  const messages = context.data.session.message
  const originalList = messages.list
  const originalGet = messages.get
  const latestExecution = rows => rows.findLast(row => row.type === "assistant" || row.type === "compaction")

  function recover(row, latest) {
    if (row?.type !== "compaction" || row.status !== "running" || !latest || row.id === latest.id) return row
    return { ...row, status: "failed", error: {
      type: "compaction.interrupted",
      message: "Итоговый статус компактинга не получен; сессия уже продолжила работу.",
    } }
  }
  function list(sessionID) {
    const rows = originalList.call(messages, sessionID)
    const latest = latestExecution(rows)
    return rows.map(row => recover(row, latest))
  }
  function get(sessionID, messageID) {
    const row = originalGet.call(messages, sessionID, messageID)
    if (row?.type !== "compaction" || row.status !== "running") return row
    return recover(row, latestExecution(originalList.call(messages, sessionID)))
  }
  messages.list = list
  messages.get = get
  return () => {
    if (messages.list === list) messages.list = originalList
    if (messages.get === get) messages.get = originalGet
  }
}
