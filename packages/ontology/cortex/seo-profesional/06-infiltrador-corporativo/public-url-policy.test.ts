import { describe, expect, it } from "vitest";
import { PublicProcurementUrlPolicy } from "./public-url-policy.js";

describe("PublicProcurementUrlPolicy", () => {
  it("allows only exact configured HTTPS origins resolving to public addresses", async () => {
    const policy = new PublicProcurementUrlPolicy(["https://compras.example"], { resolve: async () => ["8.8.8.8", "2606:4700:4700::1111"] });
    await expect(policy.authorize(new URL("https://compras.example/tenders?page=2"))).resolves.toMatchObject({ origin: "https://compras.example" });
    await expect(policy.authorize(new URL("https://evil.example/tenders"))).rejects.toThrow(/not allowlisted/u);
  });

  it("blocks private, loopback, link-local and documentation ranges", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.10.20", "192.168.1.1", "::1", "fc00::1", "fe80::1", "2001:db8::1"]) {
      const policy = new PublicProcurementUrlPolicy(["https://compras.example"], { resolve: async () => [address] });
      await expect(policy.authorize(new URL("https://compras.example/tenders"))).rejects.toThrow(/not public/u);
    }
  });
});
