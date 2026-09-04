# pi-qoder

A [pi](https://shittycodingagent.ai/) provider extension that connects pi to the **Qoder** API.

This is a global-only provider. It registers `qoder` (`https://api3.qoder.sh/`). It does not register `qoder-cn`.

## Install

Place this directory at `~/.pi/agent/extensions/pi-qoder`, then restart pi (or `/reload`).

```bash
cd ~/.pi/agent/extensions/pi-qoder
npm install
```

## Login

```text
/login qoder
```

Paste a Personal Access Token (`pt-...`) or leave empty for browser device-code login.

A PAT cannot authenticate API calls directly. The extension exchanges it for a short-lived job token, the same way `qodercli` does.

Environment (first match):

- `QODER_API_KEY`
- `QODER_PERSONAL_ACCESS_TOKEN`
- `QODER_PAT`

Setting any of those logs the provider in at startup.

PAT page: https://qoder.com/account/integrations

## Use

```text
/model Lite
```

```bash
pi --provider qoder --model Lite
```

Public model IDs are catalog `display_name` values with whitespace stripped (`Lite`, `Qwen3.8-Max`, `GLM-5.3-Flash`, …). Internal keys such as `lite` / `qmodel` are not selectable; they are mapped only when sending a request.

After login, `/model` lists the live catalog. Context uses the largest advertised option (often 1M). Output is 128K.

## Commands

The extension registers three slash commands:

```text
/qoder.usage
```

Shows plan quota and usage: personal quota and team balance (used / cap / remaining / percent), reset time, and manage link. Requires login.

```text
/qoder.model [filter]
```

Lists the models the provider would register, with context windows, thinking levels, and image support. Optional case-insensitive substring `filter` narrows the list (e.g. `/qoder.model qwen`).

```text
/qoder.doctor
```

Provider diagnostics: base URL, credential state (identity, token source: `oauth` or `pat`), PAT env var detection, and model catalog cache age/staleness, plus hints for common fixes.

## Endpoints

| | Global `qoder` |
| --- | --- |
| PAT exchange | `https://openapi.qoder.sh/api/v1/jobToken/exchange` |
| User info | `https://openapi.qoder.sh/api/v1/userinfo` |
| Usage | `https://openapi.qoder.sh/api/v2/quota/usage` |
| Chat gateway | `https://api3.qoder.sh/` |

## License

MIT
