# Analysis of public Claude Code mods

Date: 2026-10-20. Scope: 11 public repos (plus Nate Herk's four mods, already reviewed).
Method: shallow clone, then a static pattern scan (network calls, process execution, file writes, sensitive paths, obfuscation, install scripts, binaries) and a targeted read of every hit in the priority mods. **Nothing was executed or installed.** This is a static first pass, not a full audit: a clean scan is not proof of safety, and every mod should be re-read at the pinned commit before install.

Assessment lens: for use on machines that handle regulated or confidential data, "sends prompt text to a third party" is treated as disqualifying.

## Scan results

| Repo | Licence | Code files / LOC | Network | Process exec | Install scripts | Binaries |
|---|---|---|---|---|---|---|
| nateherkai/claude-code-mods | MIT | 15 / 4.3k | none | none | none | none |
| ray-amjad/claude-code-mods | MIT | 44 / 10.3k | `jev-skill-suggestion` only | git, `rm`/PowerShell (dream-pass, memory-fork) | none | none |
| scasella/claude-flightdeck | MIT | 6 / 2.4k | none | none | none | none |
| Arjun0014/project-sentinel | MIT | 120 / 43.6k | none found in the plugin | `systeminfo`, `sysctl`, `git` read-only | none | none |
| cablate/ctx-handoff-mod | MIT | 51 / 10.9k | none | dev tooling only (`tools/`) | none | none |
| HeyCubit/effortless | MIT | 98 / 27.0k | judge call, update check, textless marketplace (workers.dev) | yes | none | none |
| hamzafer/claude-code-mods | MIT | 137 / 20.7k | several mods (see below) | yes | none | none |
| OneWave-AI/claude-code-mods | MIT | 66 / 8.8k | none (curl strings are a classifier for `curl \| sh`) | none | none | none |
| YeonwooSung/my-claude-code-mods | Apache-2.0 | 181 / 18.0k | none (redaction regexes only) | minimal | none | none |
| midudev/better-claude | MIT | 52 / 8.3k | none | few | none | none |
| zycck/claude-mods | MIT | 8 / 10.2k | one api.github.com call | none | none | none |
| hellosverre/claude-skins | MIT | 89 / 22.2k | raw.githubusercontent.com (1) | none | none | none |

Not cloned: `alexgreensh/token-optimizer` (GitHub reports licence NOASSERTION; read its LICENSE first).
No committed secrets were found in any clone (AWS, GitHub, Anthropic, Slack, private-key patterns).

## Findings that matter

1. **Third-party prompt egress.** `api.typesafe.ai/v1/systemone` receives the user's prompt text from `ray-amjad/jev-skill-suggestion` (ranks skills against each prompt), `hamzafer/switchboard` (alongside `api.openai.com` and `ai-gateway.vercel.sh`), and is referenced as an optional judge URL in `HeyCubit/effortless`. Do not install these on a machine that touches regulated data.
2. **effortless** also talks to a personal Cloudflare worker (`textless-market.isac-ehrstedt.workers.dev`) for its "textless" marketplace (scene uploads, stars, reports). Not verified whether this is reachable by default or only from the project's web pages.
3. **hamzafer** mods that call out: `now-playing` (lrclib.net), `openrouter-balance` (OpenRouter with a management key), `switchboard` (above), and the CLI catalogue fetches from raw.githubusercontent.com.
4. **dream-pass** and **memory-fork** write to and delete files in the memory folder. `dream-pass` makes a backup and has undo; `memory-fork` writes directly. Both call a model (`$.model.complete` / `$.model.fork`) with memory content, so memory text leaves the machine through the user's own Claude login only (no third-party host found).

## Recommendation, by mod

| Mod | Source | Verdict | Why |
|---|---|---|---|
| secret-box | ray-amjad | **Recommended** | No network. Reads `.env`, writes `.env`/`.gitignore`, runs `git` only. Keeps secrets out of the transcript, refuses committing `.env`. |
| transcript-redactor | ray-amjad | Recommended (alternative to secret-box) | No network, no writes. secret-box already includes it, run one or the other. |
| flightdeck | scasella | **Recommended** | 6 code files, only `$.clock.now`. No network, no exec, no fs. Smallest and cleanest surface. |
| dream-pass | ray-amjad | Conditional | Rewrites/deletes memory entries. Run once with the backup, review the diff; protect any entries you intentionally keep verbatim. |
| project-sentinel | Arjun0014 | Conditional | Large (43k LOC), policy-heavy, read-only system commands. Overlaps Cache Keeper. Needs a proper read before install. |
| ctx-handoff | cablate | Skip for now | Overlaps Cache Keeper handoff and keep-warm. Clean scan. |
| effortless | HeyCubit | Skip | Egress to third-party hosts. |
| jev-skill-suggestion, switchboard | ray-amjad, hamzafer | **Do not install** | Send prompts to third parties. |
| memory-fork | ray-amjad | Skip | Background model calls on every turn, direct writes. |
| Others (OneWave, YeonwooSung, midudev, zycck, hellosverre, rest of hamzafer) | various | Not reviewed in depth | Clean scan; cosmetic or specialised. Read before use. |

## Caveats

- Pattern scan can miss dynamic code, minified strings, and anything behind the mod runtime's own API (`$.http`, `$.process`, `$.fs`, `$.model`). The priority mods were read for those calls; the others were not.
- Mod runtime permissions are not declared in manifests, so the only way to know what a mod can reach is to read its code.
- Findings are as of the pinned commits in `SOURCES.md`; repos change daily.
