from __future__ import annotations

from main import app, healthz

# Railway currently probes /health for this service. Keep /healthz as the
# canonical application endpoint and expose this compatibility alias only in
# the Railway entrypoint so application semantics remain unchanged.
app.add_api_route("/health", healthz, methods=["GET"], include_in_schema=False)
