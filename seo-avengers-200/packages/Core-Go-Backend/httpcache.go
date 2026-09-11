package core

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// RepresentationETag returns a strong, deterministic ETag for the exact bytes
// delivered to the client. It is safe for If-None-Match/304 validation.
func RepresentationETag(body []byte) string {
	sum := sha256.Sum256(body)
	return `"sha256-` + hex.EncodeToString(sum[:]) + `"`
}

// CombinedWeakETag binds an origin validator to the semantic vector snapshot.
// It is a planning/evidence primitive; callers still must verify the current
// origin representation before returning 304.
func CombinedWeakETag(originETag, vectorHash string) string {
	sum := sha256.Sum256([]byte(originETag + "\x00" + vectorHash))
	return `W/"nexus-` + hex.EncodeToString(sum[:]) + `"`
}

func IfNoneMatchMatches(header, etag string) bool {
	if etag == "" {
		return false
	}
	for _, token := range strings.Split(header, ",") {
		token = strings.TrimSpace(token)
		if token == "*" || token == etag || stripWeak(token) == stripWeak(etag) {
			return true
		}
	}
	return false
}

func stripWeak(v string) string {
	v = strings.TrimSpace(v)
	if strings.HasPrefix(v, "W/") {
		return strings.TrimSpace(strings.TrimPrefix(v, "W/"))
	}
	return v
}

func Validate304(originStatus int, requestIfNoneMatch, currentETag string) error {
	if originStatus < 200 || originStatus >= 300 {
		return fmt.Errorf("304 plan requires a successful current origin representation")
	}
	if !IfNoneMatchMatches(requestIfNoneMatch, currentETag) {
		return fmt.Errorf("If-None-Match does not match current representation")
	}
	return nil
}
