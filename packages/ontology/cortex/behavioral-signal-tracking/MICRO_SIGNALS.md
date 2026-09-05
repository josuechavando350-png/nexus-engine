# Browser micro-signal coverage for CORTEX #6

The production entry point `CortexBehavioralSignalSuite` combines the existing governed behavioral aggregate engine with a privacy-minimized browser micro-interaction tracker.

The micro-signal contract explicitly covers:

- `READING_PAUSE` with a bounded duration;
- `POINTER_ENTER` and `POINTER_DOWN` as coarse cursor/pointer intent on allowlisted elements;
- `TOUCH_START` and `TOUCH_END` as coarse tactile microinteractions on allowlisted elements.

The tracker deliberately rejects undeclared browser-detail fields such as raw coordinates, pressure, pointer IDs, touch counts and full user-agent strings. It persists only HMAC-pseudonymized event/session receipts and bounded session/site aggregates; raw event IDs, raw session IDs and raw privacy-decision references are not stored.

Both trackers share the same `OntologyTransactionPort`, scope, policy, privacy key, ACTIVE/OBSERVE_ONLY/KILLED semantics, source freshness bounds, session limits and allowlists through `CortexBehavioralSignalSuite`. The micro tracker has its own object types so cursor/touch/read-pause semantics remain distinguishable instead of being falsely mapped onto navigation or CTA counters.

This closes the audit gap between the original eight aggregate signal kinds and GREEN-SPEC #6's explicit scroll, reading-pause, cursor/pointer and touch-microinteraction coverage without adding fingerprinting or sensitive-attribute inference.
