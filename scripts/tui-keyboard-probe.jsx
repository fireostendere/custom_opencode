/** @jsxImportSource @opentui/solid */
// Loaded only by the isolated PTY smoke. No model request or real interruption.
import production from './production-tui.js'
import { sessionInterruptCommand } from './lib/session-interrupt.js'

export default {
  id: 'custom.tui-keyboard-probe',
  setup(context) {
    const cleanup = production.setup(context)
    const events = []
    const record = async (event) => {
      events.push(event)
      await Bun.write(process.env.TUI_KEYBOARD_PROBE, JSON.stringify(events))
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
      }] }))
      return null
    } })
    return () => { unslot(); cleanup?.() }
  },
}
