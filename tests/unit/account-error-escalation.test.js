import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
  })),
  pickProxyPoolId: vi.fn(),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { markAccountUnavailable, clearAccountError } from "@/sse/services/auth.js";
import { ACCOUNT_ERROR_THRESHOLD } from "open-sse/config/errorConfig.js";

// The QoderWork CN gateway answers HTTP 200 and then sends a non-200 envelope
// carrying {"code":"400","message":"Error in upstream response"} for accounts
// whose upstream identity is unusable. markAccountUnavailable must lock such
// accounts and, after repeated failures, escalate them to a persistent
// "error" state instead of cycling through short transient cooldowns.
describe("account-level error escalation", () => {
  const connId = "qdcn-broken";
  const upstreamError = '{"code":"400","message":"Error in upstream response"}';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([
      { id: connId, displayName: "Broken Account", backoffLevel: 0 },
    ]);
    mocks.updateProviderConnection.mockResolvedValue({});
  });

  it("locks per model and stays 'unavailable' before the threshold", async () => {
    const { shouldFallback } = await markAccountUnavailable(
      connId, 502, upstreamError, "qoderwork-cn", "qmodel_latest",
    );
    expect(shouldFallback).toBe(true);
    const [updatedId, update] = mocks.updateProviderConnection.mock.calls[0];
    expect(updatedId).toBe(connId);
    expect(update.testStatus).toBe("unavailable");
    expect(update.consecutiveAccountErrors).toBe(1);
    expect(update.modelLock_qmodel_latest).toBeDefined();
    expect(update.modelLock___all).toBeUndefined();
  });

  it("escalates to 'error' with an account-wide lock at the threshold", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: connId,
        displayName: "Broken Account",
        backoffLevel: 0,
        consecutiveAccountErrors: ACCOUNT_ERROR_THRESHOLD - 1,
      },
    ]);
    const { shouldFallback } = await markAccountUnavailable(
      connId, 502, upstreamError, "qoderwork-cn", "qmodel_latest",
    );
    expect(shouldFallback).toBe(true);
    const [, update] = mocks.updateProviderConnection.mock.calls[0];
    expect(update.testStatus).toBe("error");
    expect(update.consecutiveAccountErrors).toBe(ACCOUNT_ERROR_THRESHOLD);
    expect(update.modelLock___all).toBeDefined();
    expect(update.modelLock_qmodel_latest).toBeUndefined();
  });

  it("does not escalate ordinary transient errors", async () => {
    const { shouldFallback } = await markAccountUnavailable(
      connId, 429, "rate limit reached", "qoderwork-cn", "qmodel_latest",
    );
    expect(shouldFallback).toBe(true);
    const [, update] = mocks.updateProviderConnection.mock.calls[0];
    expect(update.testStatus).toBe("unavailable");
    expect(update.consecutiveAccountErrors).toBe(0);
    expect(update.modelLock___all).toBeUndefined();
  });

  it("resets the account-error streak on success", async () => {
    const conn = {
      id: connId,
      testStatus: "error",
      lastError: upstreamError,
      consecutiveAccountErrors: ACCOUNT_ERROR_THRESHOLD,
      modelLock___all: new Date(Date.now() - 1000).toISOString(),
    };
    await clearAccountError(connId, conn, "qmodel_latest");
    const [, update] = mocks.updateProviderConnection.mock.calls[0];
    expect(update.consecutiveAccountErrors).toBe(0);
    expect(update.testStatus).toBe("active");
    expect(update.lastError).toBeNull();
  });
});
