# M-02 behavioral evidence

The policy/action binding is verified in two layers:

- direct authorization rejects an action definition changed under the same action id;
- the ontology action executor rejects the same stale-policy condition before mutation.

CI must pass the full V3→V10 validation before merge.
