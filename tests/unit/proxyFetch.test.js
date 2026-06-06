import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("proxyFetch MITM bypass", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("shouldBypassMitmDns", () => {
    it("bypasses static MITM_BYPASS_HOSTS", async () => {
      const { shouldBypassMitmDns } = await import("../../open-sse/utils/proxyFetch.js");
      
      expect(shouldBypassMitmDns("https://cloudcode-pa.googleapis.com/test")).toBe(true);
      expect(shouldBypassMitmDns("https://api2.cursor.sh/test")).toBe(true);
      expect(shouldBypassMitmDns("https://example.com/test")).toBe(false);
    });

    it("bypasses *.qoder.sh when MITM_BYPASS_QODER=true", async () => {
      process.env.MITM_BYPASS_QODER = "true";
      const { shouldBypassMitmDns } = await import("../../open-sse/utils/proxyFetch.js");
      
      expect(shouldBypassMitmDns("https://center.qoder.sh/test")).toBe(true);
      expect(shouldBypassMitmDns("https://api3.qoder.sh/test")).toBe(true);
      expect(shouldBypassMitmDns("https://any.qoder.sh/test")).toBe(true);
    });

    it("bypasses *.qoder.com when MITM_BYPASS_QODER=true", async () => {
      process.env.MITM_BYPASS_QODER = "true";
      const { shouldBypassMitmDns } = await import("../../open-sse/utils/proxyFetch.js");
      
      expect(shouldBypassMitmDns("https://api.qoder.com/test")).toBe(true);
      expect(shouldBypassMitmDns("https://auth.qoder.com/test")).toBe(true);
      expect(shouldBypassMitmDns("https://any.qoder.com/test")).toBe(true);
    });

    it("does not bypass qoder hosts when MITM_BYPASS_QODER=false", async () => {
      process.env.MITM_BYPASS_QODER = "false";
      const { shouldBypassMitmDns } = await import("../../open-sse/utils/proxyFetch.js");
      
      expect(shouldBypassMitmDns("https://center.qoder.sh/test")).toBe(false);
      expect(shouldBypassMitmDns("https://api.qoder.com/test")).toBe(false);
    });

    it("does not bypass qoder hosts when MITM_BYPASS_QODER is unset", async () => {
      delete process.env.MITM_BYPASS_QODER;
      const { shouldBypassMitmDns } = await import("../../open-sse/utils/proxyFetch.js");
      
      expect(shouldBypassMitmDns("https://center.qoder.sh/test")).toBe(false);
      expect(shouldBypassMitmDns("https://api.qoder.com/test")).toBe(false);
    });

    it("bypasses MITM_BYPASS_EXTRA_HOSTS", async () => {
      process.env.MITM_BYPASS_EXTRA_HOSTS = "custom.api.com,another.host.com";
      const { shouldBypassMitmDns } = await import("../../open-sse/utils/proxyFetch.js");
      
      expect(shouldBypassMitmDns("https://custom.api.com/test")).toBe(true);
      expect(shouldBypassMitmDns("https://another.host.com/test")).toBe(true);
      expect(shouldBypassMitmDns("https://example.com/test")).toBe(false);
    });

    it("handles empty MITM_BYPASS_EXTRA_HOSTS", async () => {
      process.env.MITM_BYPASS_EXTRA_HOSTS = "";
      const { shouldBypassMitmDns } = await import("../../open-sse/utils/proxyFetch.js");
      
      expect(shouldBypassMitmDns("https://example.com/test")).toBe(false);
    });

    it("handles malformed URLs gracefully", async () => {
      const { shouldBypassMitmDns } = await import("../../open-sse/utils/proxyFetch.js");
      
      expect(shouldBypassMitmDns("not-a-url")).toBe(false);
      expect(shouldBypassMitmDns("")).toBe(false);
      expect(shouldBypassMitmDns(null)).toBe(false);
    });

    it("combines all bypass sources", async () => {
      process.env.MITM_BYPASS_QODER = "true";
      process.env.MITM_BYPASS_EXTRA_HOSTS = "custom.api.com";
      const { shouldBypassMitmDns } = await import("../../open-sse/utils/proxyFetch.js");
      
      expect(shouldBypassMitmDns("https://cloudcode-pa.googleapis.com/test")).toBe(true);
      expect(shouldBypassMitmDns("https://center.qoder.sh/test")).toBe(true);
      expect(shouldBypassMitmDns("https://api.qoder.com/test")).toBe(true);
      expect(shouldBypassMitmDns("https://custom.api.com/test")).toBe(true);
      expect(shouldBypassMitmDns("https://example.com/test")).toBe(false);
    });

    it("prevents subdomain spoofing attacks", async () => {
      process.env.MITM_BYPASS_QODER = "true";
      const { shouldBypassMitmDns } = await import("../../open-sse/utils/proxyFetch.js");
      
      expect(shouldBypassMitmDns("https://evil-qoder.sh.com/test")).toBe(false);
      expect(shouldBypassMitmDns("https://qoder.sh.evil.com/test")).toBe(false);
      expect(shouldBypassMitmDns("https://notqoder.com/test")).toBe(false);
      expect(shouldBypassMitmDns("https://fake-qoder.sh.attacker.com/test")).toBe(false);
    });

    it("bypasses qoder hosts when MITM_BYPASS_QODER=1", async () => {
      process.env.MITM_BYPASS_QODER = "1";
      const { shouldBypassMitmDns } = await import("../../open-sse/utils/proxyFetch.js");
      
      expect(shouldBypassMitmDns("https://center.qoder.sh/test")).toBe(true);
      expect(shouldBypassMitmDns("https://api.qoder.com/test")).toBe(true);
    });
  });
});
