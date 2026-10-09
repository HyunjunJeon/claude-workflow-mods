// Session state the dag-workflow plugin keeps in the host ($.state). The host holds these values across a hot reload
// of the plugin's code (/reload-plugins), which resets every module variable in hooks/register.ts.

// Keeps this file a module, so `declare module 'claude-code'` below augments the host's types instead of replacing them.
// A bare `export {}` does the same but fails `claude plugin validate` (a contract exports only types), hence the type-only form.
export type {}

declare module 'claude-code' {
  interface PluginState {
    'dag-workflow': {
      // True once the dag-workflow:planning skill was loaded in this conversation. A /clear writes false.
      planningLoaded: boolean
    }
  }
}
