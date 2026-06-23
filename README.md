# axet-pi

Pi extension that registers 17 models from the [axet](https://github.com/codefensory/axet) (NTT Data AI gateway) as a provider.

## Requirements

- [Pi](https://pi.dev) installed
- `axet-proxy.v0.1` (or the axet CLI) running on `http://localhost:54314`
- Already logged in once via `axet login` (token persisted to `~/.config/axet/state.json`)

The extension is a **pure client** of the local proxy — it does not talk to the axet gateway directly, does not handle Okta auth, and does not require any API keys. The proxy owns all of that.

## Install

Once the repo is on GitHub:

```bash
pi install https://github.com/<user>/axet-pi.git
```

For local development:

```bash
pi install ~/Dev/axet-pi
# or
pi -e ~/Dev/axet-pi/axet.ts
```

Then verify:

```bash
pi -e ~/Dev/axet-pi/axet.ts --provider axet --model "axet/gpt-4o-mini" -p "Say hi"
pi -e ~/Dev/axet-pi/axet.ts --provider axet --model "axet/eu.anthropic.claude-sonnet-4-5-20250929-v1:0" -p "Say hi"
```

## Models

17 models total (14 OpenAI + 3 Claude via Bedrock):

**OpenAI** (via `/openai/v1/*` pass-through):
- gpt-5.4-mini, gpt-5.4-nano, gpt-5.4-2026-03-05
- gpt-5.2, gpt-5.2-chat-latest
- gpt-5.1, gpt-5.1-2025-11-13, gpt-5.1-codex, gpt-5.1-codex-mini
- gpt-5-mini
- gpt-4.1, gpt-4.1-mini
- gpt-4o, gpt-4o-mini

**Claude** (via `/v1/*` provider-dispatched, translated to Bedrock InvokeModel):
- eu.anthropic.claude-haiku-4-5-20251001-v1:0
- eu.anthropic.claude-sonnet-4-5-20250929-v1:0
- eu.anthropic.claude-sonnet-4-6

## Manual catalog refresh

In a pi session, run `/axet-refresh` to re-fetch the model list from the proxy.

## How it works

Pi's `openai-completions` API talks to the axet-proxy on `localhost:54314`. The proxy handles:

- Okta token refresh (from `~/.config/axet/state.json`)
- The axet WAF fingerprinting (only undici `fetch` is accepted)
- Provider dispatch: OpenAI models pass through directly, Claude models go through `ClaudeProvider` which translates OpenAI chat format ↔ Anthropic Bedrock InvokeModel

See `axet.ts` for the full implementation (~140 lines, no npm dependencies).
