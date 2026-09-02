// Loader hook used by the config-manager regression suite: it resolves the
// bare '@opencode-ai/plugin' import to a local stub so the plugin module can
// be imported by plain Node without installing the real package.
const stubURL = new URL('./opencode-plugin-stub.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@opencode-ai/plugin') {
    return { url: stubURL, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
