import { describe, expect, it } from "vitest";
import { NodeDnsDomainIntelligenceClient, type DnsResolverPort } from "./dns-intelligence.js";

function absent(code = "ENODATA") {
  return Object.assign(new Error(code), { code });
}

describe("NodeDnsDomainIntelligenceClient", () => {
  it("collects bounded A/AAAA/MX/NS activation signals without TXT/contact harvesting", async () => {
    const resolver: DnsResolverPort = {
      resolve4: async () => ["203.0.113.20", "203.0.113.10"],
      resolve6: async () => ["2001:db8::1"],
      resolveMx: async () => [
        { exchange: "MX2.EXAMPLE.NET", priority: 20 },
        { exchange: "mx1.example.net", priority: 10 },
      ],
      resolveNs: async () => ["NS2.EXAMPLE.NET", "ns1.example.net"],
    };
    const result = await new NodeDnsDomainIntelligenceClient(resolver).inspect("Example.COM");
    expect(result).toEqual({
      domain: "example.com",
      ipv4: ["203.0.113.10", "203.0.113.20"],
      ipv6: ["2001:db8::1"],
      mx: [
        { exchange: "mx1.example.net", priority: 10 },
        { exchange: "mx2.example.net", priority: 20 },
      ],
      nameservers: ["ns1.example.net", "ns2.example.net"],
      webAddressable: true,
      mailRouted: true,
      dnsActive: true,
    });
  });

  it("treats ENODATA/ENOTFOUND as absent records but surfaces operational DNS failures", async () => {
    const resolver: DnsResolverPort = {
      resolve4: async () => { throw absent("ENODATA"); },
      resolve6: async () => { throw absent("ENOTFOUND"); },
      resolveMx: async () => { throw absent("ENODATA"); },
      resolveNs: async () => [],
    };
    await expect(new NodeDnsDomainIntelligenceClient(resolver).inspect("example.com")).resolves.toMatchObject({
      dnsActive: false,
      webAddressable: false,
      mailRouted: false,
    });

    const failing: DnsResolverPort = { ...resolver, resolveNs: async () => { throw absent("ETIMEOUT"); } };
    await expect(new NodeDnsDomainIntelligenceClient(failing).inspect("example.com")).rejects.toMatchObject({ code: "DNS_ERROR" });
  });

  it("rejects malformed resolver data instead of treating it as a signal", async () => {
    const resolver: DnsResolverPort = {
      resolve4: async () => ["not-an-ip"],
      resolve6: async () => [],
      resolveMx: async () => [],
      resolveNs: async () => [],
    };
    await expect(new NodeDnsDomainIntelligenceClient(resolver).inspect("example.com")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
