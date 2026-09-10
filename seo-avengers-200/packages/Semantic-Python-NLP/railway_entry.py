from __future__ import annotations

from render_neon_entry import app
from main import healthz

# Railway probes /health. Keep /healthz canonical and expose this compatibility
# alias while running the same Neon + local semantic provider stack as Render.
app.add_api_route("/health", healthz, methods=["GET"], include_in_schema=False)

__all__ = ["app"]
