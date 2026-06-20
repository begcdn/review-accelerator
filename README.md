# Review Accelerator

A lean desktop app for understanding AI-generated code changes.

It links to a local project folder and runs an on-demand review with two outputs:

- **Structure now:** 5-8 responsibility areas with purpose, physical files, and evidence links.
- **What changed since last review:** snapshot-based change clusters grouped by architectural meaning, plus 2-3 files/functions worth understanding before editing.

This is a comprehension layer. It does not judge correctness, security, bugs, or code quality.

## Why Electron

Tauri is the better long-term shell for size and memory, but this machine does not currently have Rust/Cargo installed. Electron lets the MVP run now with the available Node toolchain. The main-process boundary is intentionally small so the shell can be swapped later.

## Privacy

Local project does not mean private. Code excerpts and skeletons are sent to the configured LLM provider when you run a review. The MVP uses your own API key, stored locally.

## Model choice

Architectural synthesis is the quality lever. New installs default to Anthropic with `claude-sonnet-4-6`, while OpenAI and DeepSeek remain available through the provider selector. Existing OpenAI settings are preserved and upgraded away from the old `gpt-4o-mini` default.

DeepSeek uses its OpenAI-compatible API path with:

```text
Base URL: https://api.deepseek.com
Model: deepseek-v4-pro
```

## Run

```bash
npm install
npm start
```

## VPN and proxy setup

The app calls the LLM from Electron's main process. It uses the machine's network route, not Chrome extensions or browser-only VPN settings.

If OpenAI times out, add your VPN client's local HTTP or mixed proxy in **Proxy URL**:

```text
http://127.0.0.1:7890
```

Common local proxy ports are `7890`, `7897`, `8080`, `1087`, and `6152`. SOCKS-only URLs are not supported in the MVP; use the VPN client's HTTP or mixed proxy port.

Use **Test connection** before running a review.

## Verify without API calls

```bash
npm run smoke
```

## Storage

Snapshots, cached file summaries, reviews, and settings are stored in a local SQLite database under Electron's user data folder.

LLM file summaries are cached by project path, file path, and file content hash. Unchanged files are reused on later reviews.
