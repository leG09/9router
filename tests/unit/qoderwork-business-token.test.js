import { describe, expect, it } from "vitest";
import {
  extractQoderworkBusinessToken,
  sanitizeQoderworkProviderSpecificData,
  validateQoderworkBusinessToken,
} from "../../src/lib/qoderworkBusinessToken.js";

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

describe("QoderWork enterprise Web Token", () => {
  it("extracts token from a full Cookie header", () => {
    expect(extractQoderworkBusinessToken("foo=1; token=abc.def.sig; bar=2")).toBe("abc.def.sig");
  });

  it("accepts an unexpired biz JWT and records its expiry", () => {
    const token = jwt({ aud: "biz", is_biz: true, exp: 2_000 });
    const result = validateQoderworkBusinessToken(token, 1_000_000);
    expect(result.token).toBe(token);
    expect(result.expiresAt).toBe(new Date(2_000_000).toISOString());
  });

  it("rejects OAuth app and expired tokens", () => {
    expect(() => validateQoderworkBusinessToken(jwt({ aud: "oauth_app", exp: 2_000 }), 1_000_000)).toThrow(/aud=biz/i);
    expect(() => validateQoderworkBusinessToken(jwt({ aud: "biz", exp: 500 }), 1_000_000)).toThrow(/expired/i);
  });

  it("never returns the saved token to clients", () => {
    expect(sanitizeQoderworkProviderSpecificData({ businessToken: "secret", organizationId: "org-1" })).toEqual({
      hasBusinessToken: true,
      organizationId: "org-1",
    });
  });
});
