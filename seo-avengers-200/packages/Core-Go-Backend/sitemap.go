package core

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/url"
	"sort"
	"time"
)

type SitemapURL struct {
	Loc     string
	LastMod *time.Time
}
type urlset struct {
	XMLName xml.Name   `xml:"urlset"`
	Xmlns   string     `xml:"xmlns,attr"`
	URLs    []urlentry `xml:"url"`
}
type urlentry struct {
	Loc     string `xml:"loc"`
	LastMod string `xml:"lastmod,omitempty"`
}

func WriteSitemap(w io.Writer, entries []SitemapURL) error {
	cp := append([]SitemapURL(nil), entries...)
	sort.Slice(cp, func(i, j int) bool { return cp[i].Loc < cp[j].Loc })
	out := urlset{Xmlns: "http://www.sitemaps.org/schemas/sitemap/0.9"}
	for _, e := range cp {
		u, err := url.Parse(e.Loc)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return fmt.Errorf("invalid sitemap URL %q", e.Loc)
		}
		item := urlentry{Loc: e.Loc}
		if e.LastMod != nil {
			item.LastMod = e.LastMod.UTC().Format(time.RFC3339)
		}
		out.URLs = append(out.URLs, item)
	}
	_, _ = io.WriteString(w, xml.Header)
	enc := xml.NewEncoder(w)
	enc.Indent("", "  ")
	return enc.Encode(out)
}
