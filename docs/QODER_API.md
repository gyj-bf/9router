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

## 4. Enterprise Firewall Bypass (MITM DNS)

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
