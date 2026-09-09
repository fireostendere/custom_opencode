// Keep Escape in the base input mode: dialogs and autocomplete own their Escape.
export function sessionInterruptCommand(context, sessionID) {
  const pending = new Set()
  return {
    id: "session.interrupt",
    title: "Остановить выполнение",
    group: "Session",
    enabled: () => Boolean(sessionID()) && context.data.session.status(sessionID()) === "running",
    async run() {
      const id = sessionID()
      if (!id || pending.has(id) || context.data.session.status(id) !== "running") return
      pending.add(id)
      try {
        await context.client.session.interrupt({ sessionID: id, continue: false })
      } catch (error) {
        context.ui.toast.show({ message: `Не удалось остановить: ${error.message}`, variant: "error" })
      } finally {
        pending.delete(id)
      }
    },
  }
}
