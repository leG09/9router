export default {
  id: "qoderwork-cn",
  priority: 85,
  alias: "qdcn",
  uiAlias: "qdcn",
  display: {
    name: "QoderWork CN",
    icon: "water_drop",
    color: "#DB2777",
    website: "https://qwenwork.cn",
    notice: {
      signupUrl: "https://qwenwork.cn",
    },
  },
  category: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  transport: {
    baseUrl:
      "https://gateway.qwenwork.cn/algo/api/v2/service/pro/sse/agent_chat_generation",
    headers: {},
    timeoutMs: 120000,
    usage: {
      url: "https://gateway.qwenwork.cn/api/v2/quota/usage",
    },
  },
  models: [
    { id: "qwork-advanced", name: "Advanced", priceFactor: 1 },
    { id: "qwork-auto", name: "Basic", priceFactor: 0.25 },
    { id: "qwork-lite", name: "Economy", priceFactor: 0.1 },
    { id: "qmodel_latest", name: "Qwen3.8-Max", description: "Frontier model", priceFactor: 1.1, isNew: true },
  ],
  oauth: {
    openApiBaseUrl: "https://gateway.qwenwork.cn",
    chatBaseUrl: "https://gateway.qwenwork.cn",
    deviceTokenUrl: "https://gateway.qwenwork.cn/api/v1/deviceToken/poll",
    refreshUrl: "https://gateway.qwenwork.cn/api/v1/deviceToken/refresh",
    userInfoUrl: "https://gateway.qwenwork.cn/api/v1/userinfo",
    loginUrl: "https://gateway.qwenwork.cn/device/selectAccounts",
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    redirectUri: "qwenwork-cn://",
  },
  features: {
    usage: true,
    profileRefresh: true,
  },
  protocolProfile: "cn-work",
};
