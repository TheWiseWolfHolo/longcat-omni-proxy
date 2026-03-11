# LongCat Omni Proxy

A small Deno proxy for `LongCat-Flash-Omni-2603`.

It keeps normal OpenAI-style clients usable by translating common request
shapes into the structure expected by LongCat Omni:

- String `messages[].content` -> `[{ "type": "text", "text": "..." }]`
- OpenAI-style `image_url` parts -> LongCat `input_image`
- OpenAI-style `video_url` parts -> LongCat `input_video`
- Common `input_audio` payloads -> LongCat-friendly `input_audio`

## Run

```powershell
$env:LONGCAT_API_KEY="YOUR_LONGCAT_KEY"
deno task start
```

Default listen address:

- `http://127.0.0.1:8787`

Supported environment variables:

- `LONGCAT_API_KEY`
- `UPSTREAM_API_KEY`
- `UPSTREAM_BASE_URL`
- `HOST`
- `PORT`

## Endpoints

- `GET /healthz`
- `POST /v1/chat/completions`
- Other `/v1/*` paths are proxied through without special rewriting

## Notes

- The proxy only rewrites requests for `LongCat-Flash-Omni-2603`.
- Existing array-based multimodal content is preserved and only normalized when
  a LongCat-specific conversion is needed.
