/** Token counts of one turn, or summed over the session. */
export type Tokens = { input: number; output: number; cached: number }

declare module 'claude-code' {
  interface PluginState {
    'token-meter': { turn: Tokens | null; session: Tokens }
  }
}
