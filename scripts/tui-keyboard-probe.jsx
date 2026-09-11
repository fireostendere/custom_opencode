/** @jsxImportSource @opentui/solid */
// Loaded only by the isolated PTY smoke. No model request or real interruption.
import production from './production-tui.js'
import { sessionInterruptCommand } from './lib/session-interrupt.js'

export default {
  id: 'custom.tui-keyboard-probe',
  setup(context) {
    const nativeSync = context.data.location.sync
    let probeSession, failedAt, recoveredAt
    context.data.location.sync = async function (ref) {
      if (probeSession && context.ui.router.current()?.sessionID === probeSession) {
        // Keep failing every sync until 15s have passed since the first failure. If the
        // app's periodic location sync arrives mid-recovery with a canonicalized ref, the
        // recovery library cancels the pending 15s retry and restarts a run; a
        // pass-through success would stamp recoveredAt early and break the real-15s-retry
        // contract (flaky elapsed ~14.7s < 15000). Whichever run retries last is thus
        // guaranteed to have actually waited the window.
        if (!failedAt) failedAt = Date.now()
        if (Date.now() - failedAt < 15_000) {
          throw new Error('Injected location sync failure')
        }
        const result = await nativeSync.call(this, ref)
        recoveredAt = Date.now()
        return result
      }
      return nativeSync.call(this, ref)
    }
    const cleanup = production.setup(context)
    const events = []
    const record = async (event) => {
      events.push(event)
      await Bun.write(process.env.TUI_KEYBOARD_PROBE, JSON.stringify(events))
    }
    function hasNode(id, node = context.renderer.root) {
      return node?.id === id || (node?.getChildren?.() ?? []).some(child => hasNode(id, child))
    }
    async function recoveryProbe() {
      try {
        const session = await context.client.session.create({
          title: 'Location recovery acceptance', location: context.data.location.default(),
        })
        probeSession = session.id
        await context.data.session.sync(session.id)
        context.ui.router.navigate({ type: 'session', sessionID: session.id })
        let seen = false
        // Worst case two full 15s retry windows: a cancelled run restarts the clock.
        const deadline = Date.now() + 50_000
        while (Date.now() < deadline) {
          const visible = hasNode('custom.location-recovery')
          if (visible && !seen) {
            seen = true
            await record('location-warning-visible')
          }
          if (seen && !visible && recoveredAt) {
            await record({ recovery: true, elapsed: recoveredAt - failedAt,
              nativeWarning: hasNode('session.location-missing') })
            return
          }
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw new Error(`Location recovery timed out (seen=${seen}, recovered=${!!recoveredAt})`)
      } catch (error) { await record({ recovery: false, error: String(error) }) }
    }
    const stop = sessionInterruptCommand({
      ...context,
      data: { session: { status: () => 'running' } },
      client: { session: { interrupt: async (input) => {
        await record(input)
        await new Promise(resolve => setTimeout(resolve, 500))
      } } },
    }, () => 'ses_keyboard_probe')
    const unslot = context.ui.slot({ append: 'app', render: () => {
      context.keymap.layer(() => ({ mode:'base', priority:120, commands:[stop, {
        bind:'f4', title:'Keyboard probe dialog',
        run: async () => {
          await context.ui.dialog.alert({ title:'Keyboard probe', message:'Escape must close this dialog, not interrupt.' })
          await record('dialog-closed')
        },
      }, { bind:'f5', title:'Location recovery probe', run: recoveryProbe }] }))
      return null
    } })
    return () => { unslot(); cleanup?.(); context.data.location.sync = nativeSync }
  },
}
