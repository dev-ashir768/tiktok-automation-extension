import { defineConfig } from "wxt";

// Backend URL is baked in at build time — never user-input. Override via env
// for production: WXT_API_BASE=https://api.your-domain.com npx wxt build
const API_BASE = process.env.WXT_API_BASE || "http://localhost:4000";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    define: {
      __API_BASE__: JSON.stringify(API_BASE),
    },
  }),
  manifest: {
    name: "TT Partner Auto-Messenger",
    description:
      "Automated bulk messaging for TikTok Shop Partner. Built by ashirarif.com",
    author: { email: "info.ashirarif@gmail.com" },
    version: "2.0.0",
    permissions: ["storage", "activeTab", "scripting", "alarms", "tabs"],
    host_permissions: [
      "https://*.tiktokshop.com/*",
      `${API_BASE.replace(/\/$/, "")}/*`,
    ],
    action: { default_title: "TT Partner Auto-Messenger" },
    web_accessible_resources: [
      {
        resources: ["*"],
        matches: ["https://*.tiktokshop.com/*"]
      }
    ]
  },
});
