from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import urlparse


def is_google_consumer_surface(value: str) -> bool:
    """Return True for consumer google.<tld> hosts, not authorized API hosts.

    The semantic crawler has no legitimate reason to fetch Google-owned consumer
    pages. Google data must enter through a separately authorized provider/API
    contract such as googleapis.com / Search Console. This deliberately blocks
    all direct google.<tld> surfaces (Search, Maps, webhp, etc.) so a future URL
    shape cannot silently turn this worker into an automated Google client.
    """

    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    host = (parsed.hostname or "").rstrip(".").casefold()
    labels = host.split(".") if host else []
    if labels and labels[0] == "www":
        labels = labels[1:]
    return len(labels) >= 2 and labels[0] == "google"


def google_consumer_crawl_field(payload: Any) -> str | None:
    """Identify a forbidden semantic-crawl input field, or return None.

    Invalid non-string shapes are left to the Pydantic request contract. This
    helper only owns the stronger Google-consumer-network policy.
    """

    if not isinstance(payload, Mapping):
        return None
    target = payload.get("target_url")
    if isinstance(target, str) and is_google_consumer_surface(target):
        return "target_url"
    competitors = payload.get("competitor_urls")
    if isinstance(competitors, list):
        for index, value in enumerate(competitors):
            if isinstance(value, str) and is_google_consumer_surface(value):
                return f"competitor_urls[{index}]"
    return None
