function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Enterprise Web Token must be a JWT");
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Enterprise Web Token payload is invalid");
  }
}

export function extractQoderworkBusinessToken(input) {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) return "";
  const cookieMatch = value.match(/(?:^|;\s*)token=([^;]+)/i);
  return (cookieMatch?.[1] || value).trim();
}

export function validateQoderworkBusinessToken(input, nowMs = Date.now()) {
  const token = extractQoderworkBusinessToken(input);
  if (!token) return { token: "", expiresAt: null };
  if (token.length > 8192) throw new Error("Enterprise Web Token is too long");

  const payload = decodeJwtPayload(token);
  if (payload.aud !== "biz" && payload.is_biz !== true) {
    throw new Error("This is not a QoderWork enterprise Web Token (expected aud=biz)");
  }
  const expiresAtMs = Number(payload.exp) * 1000;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new Error("Enterprise Web Token has expired");
  }

  return { token, expiresAt: new Date(expiresAtMs).toISOString() };
}

export function sanitizeQoderworkProviderSpecificData(providerSpecificData) {
  if (!providerSpecificData || typeof providerSpecificData !== "object") return providerSpecificData;
  const { businessToken, ...safe } = providerSpecificData;
  return {
    ...safe,
    hasBusinessToken: typeof businessToken === "string" && businessToken.length > 0,
  };
}
