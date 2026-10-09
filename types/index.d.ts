// Session state the dag-workflow plugin keeps in the host ($.state). The host holds these values across a hot reload
// of the plugin's code (/reload-plugins), which resets every module variable in hooks/register.ts.
export type PlanningLoaded = boolean

declare module 'claude-code' {
  interface PluginState {
    'dag-workflow': {
      // True once the dag-workflow:dag-planning skill was loaded in this conversation. A /clear writes false.
      planningLoaded: PlanningLoaded
    }
  }
}
