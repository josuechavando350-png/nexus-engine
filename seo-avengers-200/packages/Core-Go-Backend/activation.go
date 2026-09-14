package core

import "fmt"

type ModuleActivation struct {
	ID          int    `json:"id"`
	Key         string `json:"key"`
	Name        string `json:"name"`
	Execution   string `json:"execution"`
	CatalogMode string `json:"catalog_mode"`
	Mode        string `json:"mode"`
	State       string `json:"state"`
	Reason      string `json:"reason"`
}

type ClientActivationPlan struct {
	Suite       string             `json:"suite"`
	SiteID      string             `json:"site_id"`
	Enabled     bool               `json:"enabled"`
	Bypassed    bool               `json:"bypassed"`
	ModuleCount int                `json:"module_count"`
	Modules     []ModuleActivation `json:"modules"`
}

// operatorReviewOverrides is a fail-closed policy layer for catalog entries
// whose historical names describe a mutation that must never become automatic
// merely because the suite-level switch is enabled. The catalog mode remains
// visible as CatalogMode for provenance; Mode is the effective activation mode.
//
// These contracts may still execute in WALLE/local mirrors to produce evidence,
// but production/provider adapters must treat ADVISORY as observe/recommend only.
var operatorReviewOverrides = map[int]string{
	18: "redirect mutation requires explicit operator approval; automatic redirect publication is forbidden",
	21: "slug restructuring requires explicit operator approval; automatic URL mutation is forbidden",
	23: "external backlink creation requires explicit operator approval; Google Search scraping and automatic external-link creation are forbidden",
	25: "conditional redirect mutation requires explicit operator approval; automatic redirect publication is forbidden",
	50: "DNS mutation requires explicit operator approval and rollback evidence; automatic DNS changes are forbidden",
}

// ActivationPlan applies one tenant-level premium switch without bypassing
// module-specific safety/eligibility gates. False is a true lazy bypass: the
// embedded 200-module catalog is not loaded and no queue/database is touched.
func ActivationPlan(siteID string, enabled bool) (ClientActivationPlan, error) {
	if siteID == "" {
		return ClientActivationPlan{}, fmt.Errorf("siteID is required")
	}
	if !enabled {
		return ClientActivationPlan{
			Suite: "SEO_AVENGERS_200", SiteID: siteID, Enabled: false,
			Bypassed: true, ModuleCount: 0, Modules: nil,
		}, nil
	}
	catalog, err := ModuleCatalog()
	if err != nil {
		return ClientActivationPlan{}, err
	}
	plan := ClientActivationPlan{
		Suite: "SEO_AVENGERS_200", SiteID: siteID, Enabled: true,
		Bypassed: false, ModuleCount: len(catalog),
		Modules: make([]ModuleActivation, 0, len(catalog)),
	}
	for _, module := range catalog {
		effectiveMode := module.Mode
		state, reason := "ON", "CONFIG_SEO_AVENGERS_200=true"
		if overrideReason, mustReview := operatorReviewOverrides[module.ID]; mustReview {
			effectiveMode = "advisory-only"
			state, reason = "ADVISORY", overrideReason
		} else {
			switch module.Mode {
			case "disabled-by-default":
				state, reason = "GATED", "module policy remains disabled until explicitly approved"
			case "eligibility-gated":
				state, reason = "GATED", "requires per-resource provider eligibility"
			case "advisory-only":
				state, reason = "ADVISORY", "produces evidence/recommendations but no automatic destructive action"
			case "experiment-safe":
				state, reason = "GATED", "requires a declared experiment allocation and invariance checks"
			case "real-rum-only":
				state, reason = "ON", "uses only real field measurements; never fabricates CrUX"
			case "consent-aware":
				state, reason = "GATED", "requires applicable user consent"
			}
		}
		plan.Modules = append(plan.Modules, ModuleActivation{
			ID: module.ID, Key: module.Key, Name: module.Name, Execution: module.Execution,
			CatalogMode: module.Mode, Mode: effectiveMode, State: state, Reason: reason,
		})
	}
	return plan, nil
}
