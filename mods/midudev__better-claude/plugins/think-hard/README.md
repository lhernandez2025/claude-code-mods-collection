# Think Hard

A Claude Code mod: start a prompt with `+` and that turn thinks at max effort. Other prompts keep the session's effort.

```text
❯ +plan the refactor of the parser
```

Claude gets `plan the refactor of the parser`, without the `+`, and every model request of that turn asks for `max` effort. Models without an effort setting are left alone.

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install think-hard@better-claude
```

## How it works

One hooks module ([`hooks/register.ts`](hooks/register.ts)): `prompt.submit` marks the turn and drops the `+`, `turn.step` sets `effort: 'max'` on each request of a marked turn, `turn.complete` clears the mark.

## Development

```bash
claude plugin validate .   # from this folder
claude plugin test .       # runs hooks/register.test.ts against the engine
```

MIT © Miguel Ángel Durán (midudev)
