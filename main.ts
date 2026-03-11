const TARGET_MODEL = "LongCat-Flash-Omni-2603";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_UPSTREAM_BASE_URL = "https://api.longcat.chat/openai";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type ProxyBuildResult = {
  body?: BodyInit | null;
  normalizedCount: number;
};

function getEnvNumber(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeProxyPath(pathname: string): string {
  if (pathname === "/openai") {
    return "/";
  }

  if (pathname.startsWith("/openai/")) {
    return pathname.slice("/openai".length);
  }

  return pathname;
}

function isJsonRequest(contentType: string | null): boolean {
  return typeof contentType === "string" &&
    contentType.toLowerCase().includes("application/json");
}

function isPlainStringContent(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripDataUrlPrefix(value: string): string {
  const commaIndex = value.indexOf(",");
  if (commaIndex === -1) {
    return value;
  }
  return value.slice(commaIndex + 1);
}

function normalizeImagePart(
  part: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const imageValue = part.image_url;
  let url = "";

  if (typeof imageValue === "string") {
    url = imageValue;
  } else if (isRecord(imageValue) && typeof imageValue.url === "string") {
    url = imageValue.url;
  }

  if (!url) {
    return part;
  }

  if (url.startsWith("data:")) {
    return {
      type: "input_image",
      input_image: {
        type: "base64",
        data: [stripDataUrlPrefix(url)],
      },
    };
  }

  return {
    type: "input_image",
    input_image: {
      type: "url",
      data: [url],
    },
  };
}

function normalizeVideoPart(
  part: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const videoValue = part.video_url;
  let url = "";

  if (typeof videoValue === "string") {
    url = videoValue;
  } else if (isRecord(videoValue) && typeof videoValue.url === "string") {
    url = videoValue.url;
  }

  if (!url) {
    return part;
  }

  if (url.startsWith("data:")) {
    return {
      type: "input_video",
      input_video: {
        type: "base64",
        data: stripDataUrlPrefix(url),
      },
    };
  }

  return {
    type: "input_video",
    input_video: {
      type: "url",
      data: url,
    },
  };
}

function normalizeAudioPart(
  part: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const audioValue = part.input_audio;
  if (!isRecord(audioValue) || typeof audioValue.data !== "string") {
    return part;
  }

  const nextAudio: Record<string, JsonValue> = { ...audioValue };
  if (typeof nextAudio.type !== "string") {
    if (audioValue.data.startsWith("data:")) {
      nextAudio.type = "base64";
      nextAudio.data = stripDataUrlPrefix(audioValue.data);
    } else if (
      audioValue.data.startsWith("http://") ||
      audioValue.data.startsWith("https://")
    ) {
      nextAudio.type = "url";
    } else {
      nextAudio.type = "base64";
    }
  }

  return {
    type: "input_audio",
    input_audio: nextAudio,
  };
}

function normalizeContentParts(
  content: JsonValue[],
): { content: JsonValue[]; count: number } {
  let count = 0;
  const nextParts = content.map((entry) => {
    if (!isRecord(entry) || typeof entry.type !== "string") {
      return entry;
    }

    switch (entry.type) {
      case "image_url": {
        count += 1;
        return normalizeImagePart(entry);
      }
      case "video_url": {
        count += 1;
        return normalizeVideoPart(entry);
      }
      case "input_audio": {
        count += 1;
        return normalizeAudioPart(entry);
      }
      default:
        return entry;
    }
  });

  return { content: nextParts, count };
}

function normalizeMessages(payload: Record<string, JsonValue>): number {
  if (payload.model !== TARGET_MODEL || !Array.isArray(payload.messages)) {
    return 0;
  }

  let normalizedCount = 0;

  for (const entry of payload.messages) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const message = entry as Record<string, JsonValue>;
    if (isPlainStringContent(message.content)) {
      message.content = [{
        type: "text",
        text: message.content,
      }];
      normalizedCount += 1;
    } else if (Array.isArray(message.content)) {
      const normalizedParts = normalizeContentParts(message.content);
      message.content = normalizedParts.content;
      normalizedCount += normalizedParts.count;
    }
  }

  // Some clients send output_modalities while others send modalities.
  if (
    Array.isArray(payload.output_modalities) &&
    !Array.isArray(payload.modalities)
  ) {
    payload.modalities = payload.output_modalities;
  }

  return normalizedCount;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function jsonResponse(
  status: number,
  body: Record<string, JsonValue>,
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
  });

  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers,
  });
}

async function buildProxyBody(
  request: Request,
  pathname: string,
): Promise<ProxyBuildResult> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { body: null, normalizedCount: 0 };
  }

  if (!isJsonRequest(request.headers.get("content-type"))) {
    return { body: request.body, normalizedCount: 0 };
  }

  const rawBody = await request.text();
  if (!rawBody) {
    return { body: rawBody, normalizedCount: 0 };
  }

  if (pathname !== "/v1/chat/completions") {
    return { body: rawBody, normalizedCount: 0 };
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(rawBody) as JsonValue;
  } catch {
    throw new Error("Invalid JSON body for /v1/chat/completions");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { body: rawBody, normalizedCount: 0 };
  }

  const payload = cloneJson(parsed as Record<string, JsonValue>);
  const normalizedCount = normalizeMessages(payload);

  return {
    body: JSON.stringify(payload),
    normalizedCount,
  };
}

function resolveUpstreamAuthorization(headers: Headers): string {
  const directAuthorization = headers.get("authorization");
  if (directAuthorization) {
    return directAuthorization;
  }

  const envKey = Deno.env.get("LONGCAT_API_KEY") ??
    Deno.env.get("UPSTREAM_API_KEY");
  if (envKey) {
    return `Bearer ${envKey}`;
  }

  return "";
}

function hasValidProxySecret(headers: Headers): boolean {
  const requiredSecret = Deno.env.get("PROXY_SHARED_SECRET");
  if (!requiredSecret) {
    return true;
  }

  return headers.get("x-proxy-secret") === requiredSecret;
}

function buildUpstreamHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("connection");

  const authorization = resolveUpstreamAuthorization(source);
  if (authorization) {
    headers.set("authorization", authorization);
  } else {
    headers.delete("authorization");
  }

  return headers;
}

function buildProxyResponseHeaders(
  upstreamHeaders: Headers,
  normalizedCount: number,
): Headers {
  const headers = new Headers(upstreamHeaders);
  headers.set("x-longcat-proxy-hit", "1");
  headers.set("x-longcat-proxy-model", TARGET_MODEL);
  headers.set("x-longcat-proxy-normalized", String(normalizedCount));
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "*");
  headers.set("access-control-allow-methods", "*");
  return headers;
}

async function handleProxy(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return jsonResponse(204, {});
  }

  const url = new URL(request.url);
  const pathname = normalizeProxyPath(url.pathname);

  if (pathname === "/" || pathname === "/healthz") {
    return jsonResponse(200, {
      ok: true,
      model: TARGET_MODEL,
      upstream_base_url: stripTrailingSlash(
        Deno.env.get("UPSTREAM_BASE_URL") ?? DEFAULT_UPSTREAM_BASE_URL,
      ),
    });
  }

  if (!hasValidProxySecret(request.headers)) {
    return jsonResponse(401, {
      error: {
        message: "Missing or invalid x-proxy-secret.",
        type: "authentication_error",
      },
    });
  }

  const upstreamBaseUrl = stripTrailingSlash(
    Deno.env.get("UPSTREAM_BASE_URL") ?? DEFAULT_UPSTREAM_BASE_URL,
  );
  const authorization = resolveUpstreamAuthorization(request.headers);
  if (!authorization) {
    return jsonResponse(500, {
      error: {
        message:
          "Missing upstream credentials. Set LONGCAT_API_KEY or UPSTREAM_API_KEY, or pass Authorization directly.",
        type: "proxy_configuration_error",
      },
    });
  }

  let proxyBuild: ProxyBuildResult;
  try {
    proxyBuild = await buildProxyBody(request, pathname);
  } catch (error) {
    return jsonResponse(400, {
      error: {
        message: error instanceof Error ? error.message : "Bad request body",
        type: "invalid_request_error",
      },
    });
  }

  const upstreamUrl = new URL(`${upstreamBaseUrl}${pathname}`);
  upstreamUrl.search = url.search;

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: buildUpstreamHeaders(request.headers),
    body: proxyBuild.body,
    redirect: "manual",
  });

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: buildProxyResponseHeaders(
      upstreamResponse.headers,
      proxyBuild.normalizedCount,
    ),
  });
}

const hostname = Deno.env.get("HOST") ?? DEFAULT_HOST;
const port = getEnvNumber("PORT", DEFAULT_PORT);

console.log(
  `LongCat Omni proxy listening on http://${hostname}:${port} for ${TARGET_MODEL}`,
);

Deno.serve({ hostname, port }, async (request) => {
  try {
    return await handleProxy(request);
  } catch (error) {
    console.error("Proxy request failed:", error);
    return jsonResponse(502, {
      error: {
        message: error instanceof Error
          ? error.message
          : "Upstream proxy failed",
        type: "proxy_error",
      },
    });
  }
});
