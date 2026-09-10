package core

import "testing"

func TestRepresentationETagAndIfNoneMatch(t *testing.T) {
	etag := RepresentationETag([]byte("<html>same</html>"))
	if !IfNoneMatchMatches(etag, etag) {
		t.Fatal("exact etag must match")
	}
	if !IfNoneMatchMatches("W/"+etag, etag) {
		t.Fatal("weak comparison must match")
	}
	if IfNoneMatchMatches(`"different"`, etag) {
		t.Fatal("different etag must not match")
	}
	if err := Validate304(200, etag, etag); err != nil {
		t.Fatal(err)
	}
}
