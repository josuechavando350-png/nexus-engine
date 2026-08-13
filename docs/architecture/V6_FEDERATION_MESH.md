# V6 Federation and Secure Mesh

Federation is an explicit relationship between trust domains. A local grant constrains remote resources/actions and expires. Trust is not transitively inherited.

The secure mesh separates:
1. workload identity/attestation;
2. authorization to communicate;
3. transport encryption;
4. discovery/routing.

SPIFFE/SPIRE is a candidate identity/attestation mechanism. WireGuard is a candidate L3 encrypted tunnel. QUIC is a candidate application transport for selected control/data paths. None of these technologies is the NEXUS trust model itself.
