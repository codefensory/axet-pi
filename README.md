# axet-pi

Pi extension that registers models from the [axet](https://github.com/codefensory/axet) (NTT Data AI gateway) as a provider. Models are fetched live from the local proxy at session start, so the exact list depends on what your NTT wallet has access to.

## Requirements

- [Pi](https://pi.dev) installed
- `axet-proxy` (or the axet CLI) running on `http://localhost:54314`
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

The exact list depends on your NTT wallet. The extension registers a **fallback** of 3 universally-available models on startup (so `pi -p` works without waiting), then replaces it with your wallet's live catalog on `session_start`:

- **OpenAI models** (via `/openai/v1/*` pass-through) — GPT-4o, GPT-4.1, GPT-5 family
- **Claude models** (via `/v1/*` provider-dispatched, translated to Bedrock InvokeModel) — `eu.anthropic.claude-*-v1:0` series

Run `/axet-refresh` in a pi session to re-fetch the catalog at any time. To see the full list from the CLI:

```bash
axet models --format json
```

## Manual catalog refresh

In a pi session, run `/axet-refresh` to re-fetch the model list from the proxy.

## How it works

Pi's `openai-completions` API talks to the axet-proxy on `localhost:54314`. The proxy handles:

- Okta token refresh (from `~/.config/axet/state.json`)
- The axet WAF fingerprinting (only undici `fetch` is accepted)
- Provider dispatch: OpenAI models pass through directly, Claude models go through `ClaudeProvider` which translates OpenAI chat format ↔ Anthropic Bedrock InvokeModel

See `axet.ts` for the full implementation (~190 lines, no npm dependencies).

## Troubleshooting

**"Axet: proxy unreachable at http://localhost:54314/v1..."**
The axet-proxy isn't running. In a separate terminal:
```bash
axet start                    # if installed via npm
```
Then run `/axet-refresh` in pi.

**"The specified model does not exist" / "Model not found in catalog"**
Your NTT wallet doesn't include that model. Run `/axet-refresh` to see what your wallet actually has, then pick from that list.

**`/axet-refresh` resets OAuth on other providers**
This is a side-effect of `unregisterProvider` in pi's model registry (it reloads all built-in models to restore any that were overridden). It only affects the current session — re-authenticate if needed.

**pi -p with `--provider axet` immediately fails**
The proxy is unreachable and the fallback list (3 universally-available models) also doesn't include what you asked for. Start the proxy first, or pick a fallback model (`axet/gpt-4o-mini`, `axet/gpt-4.1-mini`, `axet/eu.anthropic.claude-haiku-4-5-20251001-v1:0`).
