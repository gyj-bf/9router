# Qoder API Integration

9Router converts OpenAI-compatible requests to Qoder's native format.

![Qoder API Provider](../images/qoder_api_provider.png)

**References:**
- https://github.com/cubk1/qoder2api
- https://github.com/Lutiancheng1/lingma-proxy

## 1. Token Exchange

**Endpoint:** `POST https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1`

**Payload:**
```json
{
  "payload": "{\"personalToken\":\"<PERSONAL_ACCESS_TOKEN>\",\"securityOauthToken\":\"\",\"refreshToken\":\"\",\"needRefresh\":false,\"authInfo\":{}}",
  "encodeVersion": "1"
}
```

**Headers:**
```
cosy-machinetoken: <generated>
cosy-machinetype: <generated>
login-version: v2
appcode: cosy
cosy-version: 0.1.43
cosy-clienttype: 5
signature: md5("cosy&d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==&" + date)
cosy-machineid: <generated>
user-agent: Go-http-client/2.0
```

**Response:**
```json
{
  "id": "<user-id>",
  "securityOauthToken": "<token>",
  "refreshToken": "<token>",
  "expireTime": 1780000000000
}
```

9Router stores session in `providerSpecificData.qoderApiSession`.

**Example curl:**
```bash
curl 'https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1' \
  -X POST \
  -H 'cosy-machinetoken: MjFhOTJmYWItYmU1Zi00NzMwLTk3ZTAtMzI1ODRlYTU4NDUwY2M1YzQ1N2EtYz' \
  -H 'cosy-machinetype: 3f7c2a8d9b104e6f91' \
  -H 'login-version: v2' \
  -H 'appcode: cosy' \
  -H 'accept: application/json' \
  -H 'accept-encoding: identity' \
  -H 'cosy-version: 0.1.43' \
  -H 'cosy-clienttype: 5' \
  -H 'date: Wed, 03 Jun 2026 10:15:30 GMT' \
  -H 'signature: 8f0b7f4b77f37b2d8f2f8d7a2c9d4f2a' \
  -H 'content-type: application/json' \
  -H 'cosy-machineid: 7b8e3f0e-dc9f-44b0-95c8-8d8d597b3f7a' \
  -H 'user-agent: Go-http-client/2.0' \
  --data-binary '@.qoder-exchange-body.tmp'
```

> ⚠️ **Body is encoded** using `qoderEncodeBody()`, not plain JSON. Do NOT send raw JSON with `curl -d`.

## 2. Chat Generation

**Endpoint:** `POST https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`

**Key differences from OpenAI:**
- Body is encoded (not plain JSON) using `qoderEncodeBody()`
- Uses COSY authentication headers
- Message format differs for multimodal content (see section 3)

**Payload structure:**
```json
{
  "request_id": "<uuid>",
  "session_id": "<uuid>",
  "stream": true,
  "user_id": "<user-id>",
  "chat_task": "FREE_INPUT",
  "image_urls": null,
  "model_config": {
    "key": "qmodel_latest",
    "display_name": "Qwen 3.7 Max",
    "is_vl": false,
    "is_reasoning": false
  },
  "parameters": {
    "max_tokens": 32768,
    "temperature": 0.1
  },
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}
```

**Notes:**
- `model_config.is_vl` auto-set to `true` when images present
- `temperature` default: 0.1 (low randomness for coding)
- `max_tokens` default: 32768 (high for complex tasks)
- `cosy-version: 2.11.2` (override via `QODER_COSY_VERSION` env var)
- `cosy-machineos`: random from 6 platforms (anti-fingerprinting)

**Example curl:**
```bash
curl -N 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1' \
  -X POST \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -H 'cache-control: no-cache' \
  -H 'accept-encoding: identity' \
  -H 'authorization: Bearer COSY.eyJ2ZXJzaW9uIjoidjEiLCJyZXF1ZXN0SWQiOiI4NDQwNzFhOC0xN2JkLTQyNzEtYjE4ZS0xMTE1NTAwMGQwMDAiLCJpbmZvIjoiLi4uIiwiY29zeVZlcnNpb24iOiIxLjAuMCIsImlkZVZlcnNpb24iOiIifQ==.a4b12e0e3f4410c65dd4a65d4a87df33' \
  -H 'cosy-key: VktUeW9qZzZLbnJmY2l1RjZkQjZPQzB4RjB0R3pQYk5uQzZ6S2s9' \
  -H 'cosy-user: 1234567890' \
  -H 'cosy-date: 1780423640' \
  -H 'cosy-version: 2.11.2' \
  -H 'cosy-machineid: 7b8e3f0e-dc9f-44b0-95c8-8d8d597b3f7a' \
  -H 'cosy-machinetoken: MjFhOTJmYWItYmU1Zi00NzMwLTk3ZTAtMzI1ODRlYTU4NDUwY2M1YzQ1N2EtYz' \
  -H 'cosy-machinetype: 3f7c2a8d9b104e6f91' \
  -H 'cosy-machineos: x86_64_linux' \
  -H 'cosy-clienttype: 5' \
  -H 'cosy-clientip: 127.0.0.1' \
  -H 'cosy-bodyhash: 0d24e7df6f2e40a1db4a0ad2f4f8ccbb' \
  -H 'cosy-bodylength: 2048' \
  -H 'cosy-sigpath: api/v2/service/pro/sse/agent_chat_generation' \
  -H 'cosy-data-policy: disagree' \
  -H 'login-version: v2' \
  -H 'x-request-id: 2d1e2f65-3a18-4db8-9f7e-912f2b81aeca' \
  -H 'x-model-key: qmodel_latest' \
  -H 'x-model-source: system' \
  --data-binary '@.qoder-chat-body.tmp'
```

> ⚠️ **Body is encoded** using `qoderEncodeBody()`, not plain JSON. Values like `authorization`, `cosy-key`, `cosy-date`, `cosy-bodyhash`, `cosy-bodylength`, `x-request-id`, and `cosy-machineos` change per request.

## 3. Image Input

Qoder uses different message format than OpenAI for multimodal content.

**OpenAI format (input to 9Router):**
```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "What is this?"},
    {"type": "image_url", "image_url": {"url": "..."}}
  ]
}
```

**Qoder format (sent to Qoder API):**
```json
{
  "role": "user",
  "content": "What is this?",
  "contents": [
    {"type": "text", "text": "What is this?"},
    {"type": "image_url", "image_url": {"url": "..."}}
  ]
}
```

**Key differences:**
- `content` (singular): always string (text only)
- `contents` (plural): array with text + images
- Images extracted from all messages (user, assistant, system)
- Supports both nested `{image_url: {url: "..."}}` and flat `{image_url: "..."}` formats
- Supports URL and base64 (`data:image/png;base64,...`)

**Example curl with image (sent to Qoder):**
```bash
curl -N 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1' \
  -X POST \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -H 'cache-control: no-cache' \
  -H 'accept-encoding: identity' \
  -H 'authorization: Bearer COSY.eyJ2ZXJzaW9uIjoidjEiLCJyZXF1ZXN0SWQiOiI1MjY4OTFhZS02YWE3LTRlZTctYmVlZS1jZjE3YjYyMDM4ZGIiLCJpbmZvIjoiLi4uIiwiY29zeVZlcnNpb24iOiIxLjAuMCIsImlkZVZlcnNpb24iOiIifQ==.c7d3f2a1b8e9...' \
  -H 'cosy-key: VktUeW9qZzZLbnJmY2l1RjZkQjZPQzB4RjB0R3pQYk5uQzZ6S2s9' \
  -H 'cosy-user: 1234567890' \
  -H 'cosy-date: 1780590148' \
  -H 'cosy-version: 2.11.2' \
  -H 'cosy-machineid: 7b8e3f0e-dc9f-44b0-95c8-8d8d597b3f7a' \
  -H 'cosy-machinetoken: MjFhOTJmYWItYmU1Zi00NzMwLTk3ZTAtMzI1ODRlYTU4NDUwY2M1YzQ1N2EtYz' \
  -H 'cosy-machinetype: 3f7c2a8d9b104e6f91' \
  -H 'cosy-machineos: arm64_darwin' \
  -H 'cosy-clienttype: 5' \
  -H 'cosy-clientip: 127.0.0.1' \
  -H 'cosy-bodyhash: 3a7f9c2d1e8b4f6a5c0d7e2b9f1a8c3d' \
  -H 'cosy-bodylength: 4096' \
  -H 'cosy-sigpath: api/v2/service/pro/sse/agent_chat_generation' \
  -H 'cosy-data-policy: disagree' \
  -H 'login-version: v2' \
  -H 'x-request-id: 526891ae-6aa7-4ee7-beee-cf17b62038db' \
  -H 'x-model-key: qmodel_latest' \
  -H 'x-model-source: system' \
  --data-binary '@.qoder-chat-body.tmp'
```

Payload plaintext (before encoding) di `.qoder-chat-body.tmp`:
```json
{
  "request_id": "526891ae-6aa7-4ee7-beee-cf17b62038db",
  "session_id": "923b1da8-bf9f-482e-a166-1d435b312861",
  "stream": true,
  "user_id": "test-user-123",
  "chat_task": "FREE_INPUT",
  "image_urls": ["data:image/png;base64,iVBORw0KGgo..."],
  "model_config": {
    "key": "qmodel_latest",
    "display_name": "Qwen 3.7 Max",
    "is_vl": true,
    "is_reasoning": false
  },
  "chat_context": {
    "imageUrls": ["data:image/png;base64,iVBORw0KGgo..."],
    "text": {"type": "text", "text": "What animal is this?"}
  },
  "parameters": {
    "max_tokens": 4096,
    "temperature": 0.7
  },
  "messages": [
    {
      "role": "user",
      "content": "What animal is this?",
      "contents": [
        {"type": "text", "text": "What animal is this?"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo..."}}
      ]
    }
  ]
}
```

**Multiple images:**
```json
{
  "image_urls": ["https://example.com/img1.jpg", "https://example.com/img2.jpg"],
  "model_config": {"is_vl": true},
  "messages": [
    {
      "role": "user",
      "content": "Compare these",
      "contents": [
        {"type": "text", "text": "Compare these"},
        {"type": "image_url", "image_url": {"url": "https://example.com/img1.jpg"}},
        {"type": "image_url", "image_url": {"url": "https://example.com/img2.jpg"}}
      ]
    }
  ]
}
```

## 4. Reasoning Mode (Thinking/Chain-of-Thought)

9Router supports reasoning mode for Qoder models that have `is_reasoning: true` in their configuration (e.g., `dmodel`, `dfmodel`, `gm51model`). Reasoning mode enables chain-of-thought processing where the model shows its thinking process before providing the final answer.

### Enabling Reasoning Mode

Reasoning mode can be controlled via OpenAI-compatible parameters in the request body:

**Enable reasoning:**
```json
{
  "model": "qda/dmodel",
  "messages": [{"role": "user", "content": "Solve this step by step"}],
  "reasoning_effort": "high"
}
```

**Supported parameters (any of these will enable reasoning):**
- `reasoning_effort`: `"low"`, `"medium"`, `"high"` (enables), `"none"` (disables)
- `reasoning.effort`: nested object format, same values
- `thinking.type`: `"enabled"` (enables), `"disabled"` (disables)
- `enable_thinking`: `true` (enables), `false` (disables)

**Disable reasoning:**
```json
{
  "model": "qda/dmodel",
  "messages": [{"role": "user", "content": "Quick answer"}],
  "reasoning_effort": "none"
}
```

### How It Works

When reasoning mode is enabled, 9Router:

1. **Sets `is_reasoning: true`** in the `model_config` sent to Qoder API
2. **Injects `reasoning_content` placeholders** on assistant messages in multi-turn conversations (required by DeepSeek/GLM reasoning models)
3. **Sanitizes `tool_choice`** to `"auto"` if it's set to `"required"` or an object (reasoning models don't support forced tool usage)

### Payload Example with Reasoning

**Request to 9Router:**
```json
{
  "model": "qda/dmodel",
  "messages": [
    {"role": "user", "content": "What is 2+2?"},
    {"role": "assistant", "content": "4"},
    {"role": "user", "content": "Explain your reasoning"}
  ],
  "reasoning_effort": "high"
}
```

**Payload sent to Qoder API (plaintext before encoding):**
```json
{
  "request_id": "...",
  "session_id": "...",
  "stream": true,
  "user_id": "...",
  "chat_task": "FREE_INPUT",
  "model_config": {
    "key": "dmodel",
    "display_name": "DeepSeek V4 Pro",
    "is_vl": false,
    "is_reasoning": true
  },
  "chat_context": {
    "extra": {
      "modelConfig": {
        "key": "dmodel",
        "is_reasoning": true
      }
    }
  },
  "messages": [
    {"role": "user", "content": "What is 2+2?"},
    {
      "role": "assistant",
      "content": "4",
      "reasoning_content": " "
    },
    {"role": "user", "content": "Explain your reasoning"}
  ]
}
```

Note the `reasoning_content: " "` placeholder injected into the assistant message. This is required by DeepSeek/GLM reasoning models for multi-turn conversations.

### Tool Choice Sanitization

Reasoning models don't support forced tool usage. If you send `tool_choice: "required"` or an object format while reasoning is enabled, 9Router automatically sanitizes it to `"auto"`:

**Before (your request):**
```json
{
  "model": "qda/dmodel",
  "reasoning_effort": "high",
  "tool_choice": "required",
  "tools": [...]
}
```

**After (sent to Qoder):**
```json
{
  "model_config": {"is_reasoning": true},
  "tool_choice": "auto",
  "tools": [...]
}
```

A warning is logged: `[Qoder API] Neutralizing tool_choice to 'auto' (reasoning mode active)`

### Reasoning Models

The following Qoder models support reasoning mode (configured with `is_reasoning: true`):

- `dmodel` - DeepSeek V4 Pro
- `dfmodel` - DeepSeek V4
- `gm51model` - GLM 5.1

Other models (`qmodel_latest`, `qmodel`, `kmodel`, `mmodel`, etc.) have `is_reasoning: false` by default but can be forced into reasoning mode using the parameters above.

### Response Format

When reasoning mode is active, Qoder API returns `reasoning_content` in the streaming response:

```json
{
  "choices": [{
    "delta": {
      "reasoning_content": "Let me think step by step...",
      "content": null
    }
  }]
}
```

9Router passes this through to the client in OpenAI-compatible format. The `reasoning_content` field contains the model's thinking process, while `content` contains the final answer.

## 5. Enterprise Firewall Bypass (MITM DNS)

Some enterprise firewalls (FortiGate, etc.) perform DNS spoofing to intercept and inspect HTTPS traffic, which can cause `TypeError: terminated` errors when connecting to Qoder API.

### Solution: MITM DNS Bypass

Enable DNS bypass to resolve Qoder hosts via Google DNS (8.8.8.8) instead of corporate DNS:

```bash
# .env
MITM_BYPASS_QODER=true
```

This bypasses DNS-level blocking for all Qoder domains:
- `*.qoder.sh` (center.qoder.sh, api3.qoder.sh, etc.)
- `*.qoder.com` (all qoder.com subdomains)
- Any future Qoder endpoints

### How It Works

**Without MITM bypass (blocked by FortiGate):**
```
9Router → Corporate DNS → FortiGate redirects to inspection proxy
       → TLS handshake fails → TypeError: terminated
```

**With MITM bypass enabled:**
```
9Router → Google DNS (8.8.8.8) → Real Qoder IP
       → Direct TLS connection → Success ✅
```

### Topology Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ 9Router Server                                              │
│                                                             │
│  ┌──────────────┐                                           │
│  │ proxyFetch   │                                           │
│  │              │                                           │
│  │ Check:       │                                           │
│  │ MITM_BYPASS_ │                                           │
│  │ QODER=true?  │─────┐                                     │
│  └──────────────┘     │                                     │
│                       │                                     │
│  ┌──────────────┐     │    ┌──────────────────┐            │
│  │ DNS Resolver │◄────┘    │ Google DNS       │            │
│  │              │─────────►│ 8.8.8.8          │            │
│  └──────────────┘          │ 8.8.4.4          │            │
│         │                  └──────────────────┘            │
│         │                                                   │
│         │ Real IP: 47.xx.xx.xx                             │
│         ▼                                                   │
│  ┌──────────────┐                                           │
│  │ TLS Connect  │                                           │
│  │ Direct to    │                                           │
│  │ Qoder API    │──────────────────────────────────────┐   │
│  └──────────────┘                                       │   │
└─────────────────────────────────────────────────────────┼───┘
                                                          │
                                                          │
┌─────────────────────────────────────────────────────────┼───┐
│ Corporate Network (FortiGate)                           │   │
│                                                         │   │
│  ┌──────────────┐                                       │   │
│  │ Corporate    │  DNS spoofing                         │   │
│  │ DNS Server   │  (blocked by bypass)                  │   │
│  └──────────────┘                                       │   │
│                                                         │   │
│  ┌──────────────┐                                       │   │
│  │ FortiGate    │  DPI inspection                       │   │
│  │ Firewall     │  (bypassed via direct IP)             │   │
│  └──────────────┘                                       │   │
└─────────────────────────────────────────────────────────┼───┘
                                                          │
                                                          │
┌─────────────────────────────────────────────────────────┼───┐
│ Qoder API Servers                                       │   │
│                                                         │   │
│  ┌──────────────────────────────────────────────────┐  │   │
│  │ center.qoder.sh  (token exchange)                │◄─┘   │
│  │ api3.qoder.sh    (chat generation)               │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

### Configuration Options

| Variable | Description | Example |
|----------|-------------|---------|
| `MITM_BYPASS_QODER` | Enable DNS bypass for all `*.qoder.sh` and `*.qoder.com` hosts | `true` |
| `MITM_BYPASS_EXTRA_HOSTS` | Comma-separated list of additional hosts to bypass | `custom.api.com,another.host.com` |

### When to Use

**Enable MITM bypass when:**
- Running 9Router behind enterprise firewall (FortiGate, Palo Alto, etc.)
- Experiencing `TypeError: terminated` or TLS handshake failures
- Corporate DNS redirects Qoder hosts to inspection proxy

**Disable MITM bypass when:**
- Running on home network or VPS (no corporate firewall)
- Using HTTP_PROXY/HTTPS_PROXY (proxy handles DNS resolution)
- Network allows direct connections to Qoder

### Limitations

MITM DNS bypass only works if the firewall uses **DNS-level blocking**. It will NOT bypass:
- IP-level blocking (firewall blocks Qoder IP ranges)
- Deep packet inspection with forced proxy (all traffic must go through proxy)
- Certificate pinning enforcement (rare for API endpoints)

For these cases, use `HTTP_PROXY`/`HTTPS_PROXY` to route through an external proxy.

### Security Considerations

When using MITM bypass:
- ✅ TLS certificate validation still occurs (hostname verified against cert)
- ✅ Safe for public CA-issued certificates (Qoder, Google, GitHub)
- ⚠️ Bypasses corporate DNS-based security controls
- ⚠️ May violate corporate security policies - get approval before use
- ❌ Does NOT protect against IP-level blocking or forced proxy scenarios

**Important:** Only enable MITM bypass on networks you trust. The bypass prevents DNS-level inspection but does not disable TLS certificate validation, so connections remain secure against man-in-the-middle attacks.

## 6. Activity / Free Quota Tracker

**Discovered from:** `@qoder-ai/qodercli` npm package (v1.0.14) source code — `listActivities()` method.

**Endpoint:** `GET https://center.qoder.sh/algo/api/v2/activity`

**Auth:** COSY signing (RSA+AES+MD5) via `buildCosyHeaders()` — same as chat endpoint (section 2).

**Extra header:** `Accept-Language: en-US`

### Flow

1. **Exchange** personal token → `securityOauthToken` + `userId` (via `jobToken` endpoint, section 1)
2. **Sign** request using COSY headers with exchanged credentials
3. **GET** `/algo/api/v2/activity` — returns promotional activities including free model quota

### Response

```json
{
  "code": 0,
  "msg": "ok",
  "data": {
    "activities": [
      {
        "type": "MODEL_FREE_QUOTA",
        "activityId": "qwen3.7max_200_free_invoke",
        "modelName": "Qwen3.7-Max Free Calls",
        "tag": "Limited-Time Perk",
        "tagStyle": "FREE",
        "modelKeys": ["qmodel_latest"],
        "limit": 200,
        "used": 0,
        "remaining": 200,
        "resetAt": 1780848000000,
        "resetStrategy": "DAY_EXPIRE",
        "serverTimezone": "Asia/Shanghai",
        "description": "Daily 200 free requests, resets at 00:00 (UTC+8)",
        "statusText": "200 left today",
        "eligible": true,
        "activityEndAt": 1788192000000,
        "detailUrl": "https://docs.qoder.com/events/qwen-max-daily-free"
      }
    ],
    "queryAt": 1780845256899
  }
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `activities[].type` | string | Activity type: `MODEL_FREE_QUOTA` |
| `activities[].activityId` | string | Unique activity identifier |
| `activities[].modelName` | string | Display name of the free model |
| `activities[].modelKeys` | string[] | Model keys this quota applies to (e.g., `qmodel_latest`) |
| `activities[].limit` | number | Daily request limit |
| `activities[].used` | number | Requests used today |
| `activities[].remaining` | number | Requests remaining today |
| `activities[].resetAt` | number | Reset timestamp (ms, Asia/Shanghai timezone) |
| `activities[].resetStrategy` | string | `DAY_EXPIRE` = resets daily at 00:00 UTC+8 |
| `activities[].eligible` | boolean | Whether this account is eligible for the free quota |
| `activities[].activityEndAt` | number | Campaign end timestamp (ms) |
| `data.queryAt` | number | Server timestamp when query was processed |

### Example curl

```bash
# Step 1: Exchange personal token (see section 1)
# Step 2: Build COSY headers and call activity endpoint

# Pseudo-curl (headers generated by buildCosyHeaders):
curl -s "https://center.qoder.sh/algo/api/v2/activity" \
  -H "Authorization: Bearer COSY.<payloadB64>.<signature>" \
  -H "Cosy-Key: <rsaEncryptedAesKey>" \
  -H "Cosy-User: <userId>" \
  -H "Cosy-Date: <unixTimestamp>" \
  -H "Cosy-Version: 2.11.2" \
  -H "Cosy-Machineid: <machineId>" \
  -H "Cosy-Machinetoken: <machineToken>" \
  -H "Cosy-Machinetype: <machineType>" \
  -H "Cosy-Machineos: x86_64_linux" \
  -H "Cosy-Clienttype: 5" \
  -H "Cosy-Clientip: 127.0.0.1" \
  -H "Cosy-Bodyhash: <md5OfEmptyBody>" \
  -H "Cosy-Bodylength: 0" \
  -H "Cosy-Sigpath: /api/v2/activity" \
  -H "Cosy-Data-Policy: disagree" \
  -H "Login-Version: v2" \
  -H "X-Request-Id: <uuid>" \
  -H "Accept-Language: en-US"
```

### Integration Notes

- The Qoder CLI calls `listActivities()` alongside `getUserPlan()` and `getQuotaUsage()` at startup
- `getQuotaUsage()` uses a different endpoint: `GET https://openapi.qoder.sh/api/v2/quota/usage` (Bearer auth, section 2)
- Activity data tracks **promotional free calls** (e.g., Qwen3.7-Max 200 daily free), separate from Credits-based quota
- The `modelKeys` array maps to `model_config.key` in chat requests (e.g., `qmodel_latest` = Qwen 3.7 Max)
- Campaign has an end date (`activityEndAt`) — check `eligible` flag before relying on free quota

## 7. Session Management

9Router manages Qoder API sessions with proactive token refresh to prevent mid-request failures.

### Session Lifecycle

1. **Token Exchange**: PAT → `securityOauthToken` (section 1)
2. **Session Cached**: Stored in `credentials.providerSpecificData.qoderApiSession`
3. **Proactive Refresh**: If session expires within 5 minutes, re-exchange before sending request
4. **Session Fields**: `userId`, `securityOauthToken`, `refreshToken`, `expiresAt`, `exchangedAt`, machine credentials

### Refresh Margin

```javascript
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes
```

If `session.expiresAt - Date.now() <= 5 minutes`, the session is treated as expired and re-exchanged proactively. This prevents:
- Mid-request token expiry when upstream is slow
- Failed requests during large payload processing
- Timeout issues with reasoning models (long inference times)

Previously 30 seconds, which was too tight for slow networks or brief outages.

### Session Validation

```javascript
isQoderApiSessionValid(session, refreshMarginMs = DEFAULT_REFRESH_MARGIN_MS)
```

Returns `false` if:
- Session is null/invalid
- Missing `userId` or `securityOauthToken`
- `expiresAt` is not a finite number
- `expiresAt - Date.now() <= refreshMarginMs`

## 8. SSE Unwrapping

Qoder API returns SSE streams in a custom envelope format. 9Router unwraps this into standard OpenAI SSE format.

### Qoder Envelope Format

```
data: {"statusCodeValue":200,"body":"{\"id\":\"chatcmpl-1\",\"choices\":[...]}"}

data: {"statusCodeValue":200,"body":"{\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}"}

data: [DONE]
```

Each SSE frame contains:
- `statusCodeValue`: HTTP status (200 = success)
- `body`: JSON string with OpenAI-compatible payload

### Unwrapped Format (OpenAI-compatible)

```
data: {"id":"chatcmpl-1","choices":[...]}

data: {"choices":[{"delta":{"content":"Hello"}}]}

data: [DONE]
```

### Implementation

`wrapQoderApiSSE(response, model)` transforms the stream:
1. Parses each SSE frame
2. Extracts `body` field from envelope
3. Emits unwrapped JSON as standard OpenAI SSE
4. Handles chunked frames (one envelope split across multiple byte chunks)
5. Forwards tool_call deltas in real-time (before stream closes)
6. Emits single `[DONE]` at end

### Error Handling in Stream

If `statusCodeValue !== 200`:
```json
{"statusCodeValue": 500, "body": "{\"error\":\"upstream failure\"}"}
```

Logged as: `[Qoder API] Upstream error in stream { statusValue: 500, body: "..." }`

## 9. Error Handling

9Router returns OpenAI-compatible error responses with appropriate HTTP status codes.

### Error Response Format

```json
{
  "error": {
    "message": "Authentication failed. Please check your API key",
    "type": "authentication_error",
    "code": "invalid_api_key"
  }
}
```

### Error Types

| HTTP Status | Error Type | Code | Description |
|-------------|------------|------|-------------|
| 401 | `authentication_error` | `invalid_api_key` | Missing/invalid API key or session exchange failed |
| 401 | `authentication_error` | `auth_failed` | COSY header building failed |
| 500 | `server_error` | `invalid_request` | Payload building failed |
| 500 | `server_error` | `internal_error` | Body encoding failed |
| 502 | `upstream_error` | `upstream_5xx` | Qoder API returned 5xx status |
| 503 | `server_error` | `network_error` | Network request failed (DNS, timeout, connection refused) |

### Error Logging

All errors are logged with `[Qoder API]` tag:
- `requestId`: Unique request identifier
- `error`: Error message (no stack traces)
- `status`: HTTP status (for upstream errors)
- `statusText`: HTTP status text

Error body truncated to 500 characters to prevent log spam.

### Success Logging

Successful requests logged as:
```
[Qoder API] Chat request successful { requestId: "...", modelKey: "qmodel_latest", status: 200 }
```

## 10. Regional Routing

Qoder API has multiple regional inference endpoints. Override via `QODER_API_REGION` environment variable.

### Available Regions

| Region | Host | Latency (from Asia) | Notes |
|--------|------|---------------------|-------|
| `sg` (default) | `api2.qoder.sh` | ~1.1s | Lowest latency from Asia |
| `jp` | `api3.qoder.sh` | ~1.4s | Japan, good fallback |
| `us` | `api1.qoder.sh` | ~2.4s | US East, highest latency from Asia |

All three hosts verified to support:
- PAT authentication
- COSY signing
- Body encoding
- SSE streaming

### Configuration

```bash
# .env
QODER_API_REGION=sg  # Options: us, sg, jp (default: sg)
```

### Dynamic URL Resolution

All Qoder API calls use dynamic URL functions:
- `getQoderChatUrl()` → Chat generation endpoint
- `getQoderActivityUrl()` → Activity/quota tracker
- `getQoderModelListUrl()` → Model list (OAuth only)

Example:
```javascript
// QODER_API_REGION=us
getQoderChatUrl()
// → "https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"

// QODER_API_REGION=sg (default)
getQoderChatUrl()
// → "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?..."
```

### When to Change Region

**Use `sg` (default) when:**
- Running from Asia (Singapore, Tokyo, Seoul, etc.)
- No specific requirements

**Use `jp` when:**
- `sg` is experiencing issues
- Running from Japan

**Use `us` when:**
- Running from North America
- `sg` and `jp` are both down

### Invalid Values

Invalid region values (e.g., `eu`, `invalid`, empty string) fall back to `sg`:
```javascript
process.env.QODER_API_REGION = "eu";
getQoderRegion(); // → "sg"
```

Case-insensitive and whitespace-trimmed:
```javascript
process.env.QODER_API_REGION = "  US  ";
getQoderRegion(); // → "us"
```

## 11. Environment Variables

### Authentication

| Variable | Description | Example |
|----------|-------------|---------|
| `QODER_API_KEY` | Personal Access Token (PAT) for qoder-api provider | `pt-ng52Qyv...` |

### Regional Routing

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `QODER_API_REGION` | Regional inference host (`us`, `sg`, `jp`) | `sg` | `jp` |

### COSY Protocol

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `QODER_COSY_VERSION` | COSY protocol version | `2.11.2` | `2.12.0` |

### Network Bypass

| Variable | Description | Example |
|----------|-------------|---------|
| `MITM_BYPASS_QODER` | Enable DNS bypass for enterprise firewalls | `true` |
| `MITM_BYPASS_EXTRA_HOSTS` | Additional hosts to bypass | `custom.api.com` |

### Proxy

| Variable | Description | Example |
|----------|-------------|---------|
| `HTTP_PROXY` | HTTP proxy URL | `http://proxy:8080` |
| `HTTPS_PROXY` | HTTPS proxy URL | `http://proxy:8080` |

## 12. Model Configuration

### Static Model Map

The qoder-api provider uses static model configurations (no live fetch from `/algo/api/v2/model/list`):

| Model Key | Display Name | Reasoning | Vision | Max Input Tokens |
|-----------|--------------|-----------|--------|------------------|
| `auto` | Auto | ❌ | ❌ | 180,000 |
| `ultimate` | Ultimate | ❌ | ❌ | 180,000 |
| `performance` | Performance | ❌ | ❌ | 180,000 |
| `efficient` | Efficient | ❌ | ❌ | 131,072 |
| `lite` | Lite (Free tier) | ❌ | ❌ | 131,072 |
| `qmodel_latest` | Qwen 3.7 Max | ❌ | ❌ | 180,000 |
| `qmodel` | Qwen 3.6 Plus | ❌ | ❌ | 180,000 |
| `dmodel` | DeepSeek V4 Pro | ✅ | ❌ | 180,000 |
| `dfmodel` | DeepSeek V4 | ✅ | ❌ | 180,000 |
| `gm51model` | GLM 5.1 | ✅ | ❌ | 131,072 |
| `kmodel` | Kimi K2.6 | ❌ | ❌ | 180,000 |
| `mmodel` | MiniMax M2.7 | ❌ | ❌ | 180,000 |

### Default Parameters

```javascript
DEFAULT_MAX_OUTPUT_TOKENS = 32768  // High for complex coding tasks
DEFAULT_TEMPERATURE = 0.1          // Low randomness for coding
```

### Vision Models

Vision capability (`is_vl: true`) is auto-detected when images are present in messages. Any model can process images if the request contains `image_url` content.

### Reasoning Models

Models with `is_reasoning: true` by default:
- `dmodel` (DeepSeek V4 Pro)
- `dfmodel` (DeepSeek V4)
- `gm51model` (GLM 5.1)

Other models can be forced into reasoning mode via `reasoning_effort`, `thinking.type`, or `enable_thinking` parameters (see section 4).

## 13. OpenAI Parameter Passthrough

9Router passes through standard OpenAI parameters to Qoder API when present in the request body.

### Supported Parameters

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `temperature` | number | Sampling temperature (0-2) | `0.7` |
| `max_tokens` | number | Max output tokens | `4096` |
| `max_completion_tokens` | number | Alias for max_tokens | `4096` |
| `top_p` | number | Nucleus sampling (0-1) | `0.9` |
| `presence_penalty` | number | Penalize tokens by presence (-2 to 2) | `0.5` |
| `frequency_penalty` | number | Penalize tokens by frequency (-2 to 2) | `0.5` |
| `stop` | string/string[] | Stop sequences | `["\n", "END"]` |
| `parallel_tool_calls` | boolean | Allow parallel tool calls | `false` |
| `response_format` | object | Response format (e.g., JSON mode) | `{"type": "json_object"}` |

### Parameter Mapping

Parameters are mapped to Qoder's `parameters` object:

**Request to 9Router:**
```json
{
  "model": "qda/qmodel_latest",
  "messages": [{"role": "user", "content": "Hello"}],
  "temperature": 0.7,
  "max_tokens": 4096,
  "top_p": 0.9,
  "presence_penalty": 0.5,
  "frequency_penalty": 0.3,
  "stop": ["\n\n"]
}
```

**Payload sent to Qoder:**
```json
{
  "parameters": {
    "temperature": 0.7,
    "max_tokens": 4096,
    "top_p": 0.9,
    "presence_penalty": 0.5,
    "frequency_penalty": 0.3,
    "stop": ["\n\n"]
  }
}
```

### max_tokens vs max_completion_tokens

If both are present, `max_tokens` takes precedence:
```json
{
  "max_tokens": 4096,
  "max_completion_tokens": 2048
}
// → parameters.max_tokens = 4096
```

If only `max_completion_tokens` is present:
```json
{
  "max_completion_tokens": 2048
}
// → parameters.max_tokens = 2048
```

If neither is present, uses default `32768`.

### Reasoning Parameters

See section 4 for reasoning-specific parameters:
- `reasoning_effort`: `"low"`, `"medium"`, `"high"`, `"none"`
- `reasoning.effort`: nested format
- `thinking.type`: `"enabled"`, `"disabled"`
- `enable_thinking`: boolean

### Tool Parameters

- `tools`: Array of tool definitions (passed through)
- `tool_choice`: `"auto"`, `"none"`, `"required"`, or object (sanitized to `"auto"` when reasoning is active)

### Unsupported Parameters

The following OpenAI parameters are **not** passed through to Qoder:
- `n` (multiple completions) — Qoder only supports single completion
- `logit_bias` — not supported by Qoder backend
- `user` — not used by Qoder
- `seed` — not supported
- `logprobs` — not supported

These parameters are silently ignored if present in the request.
