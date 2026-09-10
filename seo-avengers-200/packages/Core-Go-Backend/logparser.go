package core

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"time"
)

type CrawlEvent struct {
	At        time.Time `json:"at"`
	Method    string    `json:"method"`
	Path      string    `json:"path"`
	Status    int       `json:"status"`
	UserAgent string    `json:"user_agent"`
	RemoteIP  string    `json:"remote_ip,omitempty"`
	IsBotUA   bool      `json:"is_googlebot_ua"`
}

// ParseJSONLines decodes structured server logs without trusting User-Agent as proof of crawler identity.
func ParseJSONLines(ctx context.Context, r io.Reader, emit func(CrawlEvent) error) error {
	s := bufio.NewScanner(r)
	buf := make([]byte, 64*1024)
	s.Buffer(buf, 2*1024*1024)
	for s.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		var e CrawlEvent
		if err := json.Unmarshal(s.Bytes(), &e); err != nil {
			continue
		}
		e.IsBotUA = strings.Contains(strings.ToLower(e.UserAgent), "googlebot")
		if err := emit(e); err != nil {
			return err
		}
	}
	return s.Err()
}
