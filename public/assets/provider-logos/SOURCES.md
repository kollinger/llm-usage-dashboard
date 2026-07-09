# Provider Logo Sources

The dashboard bundles local SVG assets and does not hotlink provider logos at runtime.

## Source Package

- `@lobehub/icons` `5.10.1`
- License: MIT
- Repository: `https://github.com/lobehub/lobe-icons`
- Package metadata checked with `npm view @lobehub/icons@5.10.1`.
- Only the monochrome provider SVG paths listed below were extracted. They render with `currentColor` inside the dashboard's provider mark frame.

## Bundled Assets

| Asset | Provider surface |
| --- | --- |
| `codex.svg` | Codex / Codex Spark |
| `openai.svg` | OpenAI API |
| `anthropic.svg` | Anthropic API |
| `claude.svg` | Claude / Fable model family |
| `claude-code.svg` | Claude Code |
| `gemini.svg` | Google Gemini |
| `github-copilot.svg` | GitHub Copilot |
| `zai.svg` | Z.AI |
| `chatglm.svg` | GLM / ChatGLM |
| `minimax.svg` | MiniMax |
| `deepseek.svg` | DeepSeek |
| `alibaba.svg` | Alibaba |
| `qwen.svg` | Qwen |
| `xai.svg` | xAI / Grok |
| `mistral.svg` | Mistral |
| `stepfun.svg` | StepFun |

## Fallback Policy

Known providers above use bundled local SVGs. Unknown provider names still render a local initials fallback generated from the provider label; no remote image is requested. Fable is a Claude/Anthropic model family in the current data model, so it uses the Claude/Anthropic mark rather than a separate invented Fable logo.
