# @nexus/ads-server-side-tracking

Production primitives for routing consented first-party measurement through a Google Tag Manager server container.

This package intentionally contains no customer IDs, Google Ads conversion IDs, secrets, or deployment-specific URLs. A client installation must provide its own published GTM server container and configuration. Missing or invalid runtime configuration fails closed instead of silently falling back to direct third-party collection.

## Supported production flows

### Website -> GTM server container

Use `buildGoogleTagServerConfig()` to configure the Google tag / GTM web container with Google's documented `server_container_url` setting. Use `buildGoogleConsentModeDefaults()` with the site's real consent decision before measurement is enabled.

```ts
const googleConfig = buildGoogleTagServerConfig("https://metrics.customer.example");
// gtag("config", "G-XXXXXXXXXX", googleConfig)
```

Google recommends using a first-party domain for the tagging server. `buildServerContainerCspSources()` returns the origin that must be considered for `img-src`, `connect-src`, and `frame-src`; the application remains responsible for composing those values with its existing CSP rather than replacing its security policy.

### Backend -> GTM server container

Google documents server-to-server ingestion through the server container's Measurement Protocol client. Create and publish a Measurement Protocol client in the GTM server container, choose its Activation Path (for example `/batch`), then instantiate the transport with that same path and the destination tag ID expected by the container.

```ts
const tracking = createGtmServerTransport({
  serverContainerUrl: "https://metrics.customer.example",
  activationPath: "/batch",
  tagId: "G-XXXXXXXXXX",
});

await tracking.send({
  eventName: "lead_submitted",
  eventId: crmEvent.id,
  clientId: consentedAnalyticsClientId,
  consent,
  category: "lead",
  clickIds: extractGoogleClickIds(originalLandingUrl),
});
```

The transport sends the documented Measurement Protocol form payload to the server container over HTTPS, enforces a timeout, rejects redirects, throws on non-2xx responses, and does not automatically retry. Automatic retries are deliberately omitted because a network retry can duplicate measurement unless the customer's downstream deduplication contract is known.

`clientId` is mandatory. Nexus does not create a hidden browser fingerprint or synthesize a cross-session identity. The caller must supply an identifier it is legitimately allowed to use.

### Google Ads Enhanced Conversions

`hashEnhancedConversionUserData()` applies Google's documented normalization rules and SHA-256 hashing before returning `user_data`: trim/lowercase, Gmail/Googlemail local-part dot removal, E.164 phone validation, and hex SHA-256 for protected fields. It accepts email, phone, or Google's complete-address matching key (first name, last name, postal code, country). `buildEnhancedConversionDataLayerEvent()` also blocks protected raw-data keys from generic parameters.

```ts
const event = buildEnhancedConversionDataLayerEvent({
  eventName: "qualified_lead",
  eventId: lead.id,
  transactionId: order.id,
  consent,
  userData: {
    email: lead.email,
    phoneNumber: lead.phoneE164,
  },
  parameters: { lead_value_bucket: "high" },
});

// dataLayer.push(event)
```

`transactionId` is optional because not every conversion is a purchase, but when provided it is emitted as `transaction_id`, capped at Google's 64-character limit, and reserved from generic parameters. It must be a unique, backend-generated, non-PII transaction/order identifier. Google Ads uses matching transaction IDs to minimize duplicate conversion counting.

In GTM, assign the resulting `user_data` field to the Google tag / GA4 event flow sent to the server container. In the server container, configure Conversion Linker plus the Google Ads Conversion Tracking tag and its trigger. Google states that the server-side Ads conversion tag consumes available conversion data, including user-provided data, when it fires.

## Consent behavior

- `analyticsStorage: denied`: server Measurement Protocol dispatch is rejected before network I/O.
- `adStorage: denied`: GCLID/WBRAID/GBRAID values are removed before dispatch.
- `adUserData: denied`: Enhanced Conversion hashing/building is rejected.
- `adPersonalization: denied`: backend Measurement Protocol events include `npa=1`.

The package does not attempt to bypass browser privacy choices, consent, or ad-blocking controls.

## Validation checklist for a client installation

1. Deploy and publish the GTM server container on a first-party HTTPS domain.
2. Configure the GA4 client for website traffic and/or the Measurement Protocol client for server-to-server traffic.
3. Configure and publish Conversion Linker and the server-side Google Ads Conversion Tracking tag when Ads conversions are required.
4. Set `server_container_url` in the customer's Google tag/web container.
5. Apply the site's real consent state before emitting events.
6. For purchase-like conversions, generate a unique non-PII transaction ID in the backend and map `transaction_id` through GTM to Google Ads.
7. Use GTM Preview/Tag Assistant to confirm the server client claims requests and the intended tags fire.
8. Verify Google Ads diagnostics and deduplication before removing an existing equivalent conversion tag.

Offline conversion uploads through an Ads/Data Manager API are deliberately not implemented here; that is Nexus module 3 and will have its own credentials, idempotency, and reconciliation contract.
