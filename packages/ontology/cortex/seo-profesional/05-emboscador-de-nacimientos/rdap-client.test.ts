import { describe, expect, it, vi } from "vitest";
import { IanaRdapClient, normalizeDomainName } from "./rdap-client.js";

function bootstrap() {
  return {
    version: "1.0",
    publication: "2026-09-08T00:00:00Z",
    services: [
      [["com"], ["https://rdap.example.test/com/v1/"]],
      [["mx"], ["https://rdap.example.test/mx/"]],
    ],
  };
}

describe("IanaRdapClient", () => {
  it("discovers the authoritative RDAP service through IANA bootstrap and keeps only non-contact registration signals", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url === "https://data.iana.org/rdap/dns.json") {
        return new Response(JSON.stringify(bootstrap()), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://rdap.example.test/com/v1/domain/example.com") {
        return new Response(JSON.stringify({
          objectClassName: "domain",
          ldhName: "EXAMPLE.COM",
          status: ["active", "client transfer prohibited"],
          events: [
            { eventAction: "registration", eventDate: "2026-09-06T10:00:00Z" },
            { eventAction: "last changed", eventDate: "2026-09-07T10:00:00Z" },
            { eventAction: "expiration", eventDate: "2027-09-06T10:00:00Z" },
          ],
          nameservers: [{ ldhName: "NS1.EXAMPLE.NET" }, { ldhName: "ns2.example.net" }],
          secureDNS: { delegationSigned: true },
          entities: [{
            handle: "REGISTRAR-123",
            roles: ["registrar"],
            vcardArray: ["vcard", [["email", {}, "text", "private-person@example.invalid"]]],
          }],
        }), { status: 200, headers: { "content-type": "application/rdap+json" } });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const client = new IanaRdapClient({ fetchImpl, maxReadRetries: 0, now: () => Date.parse("2026-09-08T12:00:00.000Z") });
    const result = await client.lookupDomain("Example.COM.");
    expect(urls).toEqual([
      "https://data.iana.org/rdap/dns.json",
      "https://rdap.example.test/com/v1/domain/example.com",
    ]);
    expect(result).toEqual({
      status: "REGISTERED",
      record: {
        domain: "example.com",
        registrationDate: "2026-09-06T10:00:00.000Z",
        lastChangedDate: "2026-09-07T10:00:00.000Z",
        expirationDate: "2027-09-06T10:00:00.000Z",
        statuses: ["active", "client transfer prohibited"],
        nameservers: ["ns1.example.net", "ns2.example.net"],
        registrarHandle: "REGISTRAR-123",
        delegationSigned: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-person@example.invalid");
  });

  it("treats an authoritative 404 as not registered and reuses the cached bootstrap", async () => {
    let bootstrapReads = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === "https://data.iana.org/rdap/dns.json") {
        bootstrapReads += 1;
        return new Response(JSON.stringify(bootstrap()), { status: 200 });
      }
      return new Response(JSON.stringify({ errorCode: 404 }), { status: 404 });
    });
    const client = new IanaRdapClient({ fetchImpl, maxReadRetries: 0, now: () => 1_000_000 });
    await expect(client.lookupDomain("new-one.com")).resolves.toEqual({ status: "NOT_REGISTERED", domain: "new-one.com" });
    await expect(client.lookupDomain("new-two.com")).resolves.toEqual({ status: "NOT_REGISTERED", domain: "new-two.com" });
    expect(bootstrapReads).toBe(1);
  });

  it("normalizes IDN input and rejects malformed hostnames before network access", () => {
    expect(normalizeDomainName("BÜCHER.example")).toBe("xn--bcher-kva.example");
    expect(() => normalizeDomainName("https://example.com/path")).toThrow(/malformed label/u);
    expect(() => normalizeDomainName("localhost")).toThrow(/public suffix/u);
  });
});
