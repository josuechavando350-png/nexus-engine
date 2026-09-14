from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import urlparse


def is_google_consumer_surface(value: str) -> bool:
    """Return True for direct google.<tld> web surfaces, including subdomains.

    The semantic crawler has no legitimate reason to fetch Google-owned web
    pages. Google data must enter through a separately authorized provider/API
    contract such as googleapis.com / Search Console. This deliberately blocks
    direct google.<tld> surfaces and their subdomains (Search, Maps, News,
    developers.google.com, etc.) so a future URL shape cannot silently turn
    this worker into an automated Google web client. Hosts such as
    googleapis.com do not contain a standalone ``google`` DNS label and remain
    available only to their dedicated authorized adapters.
    """

    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    host = (parsed.hostname or "").rstrip(".").casefold()
    labels = host.split(".") if host else []
    return len(labels) >= 2 and "google" in labels


def google_consumer_crawl_field(payload: Any) -> str | None:
    """Identify a forbidden semantic-crawl input field, or return None.

    Invalid non-string shapes are left to the Pydantic request contract. This
    helper only owns the stronger Google-web-network policy.
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
