package core

import "fmt"

type ModuleActivation struct {
	ID        int    `json:"id"`
	Key       string `json:"key"`
	Name      string `json:"name"`
	Execution string `json:"execution"`
	Mode      string `json:"mode"`
	State     string `json:"state"`
	Reason    string `json:"reason"`
}

type ClientActivationPlan struct {
	Suite       string             `json:"suite"`
	SiteID      string             `json:"site_id"`
	Enabled     bool               `json:"enabled"`
	Bypassed    bool               `json:"bypassed"`
	ModuleCount int                `json:"module_count"`
	Modules     []ModuleActivation `json:"modules"`
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
		state, reason := "ON", "CONFIG_SEO_AVENGERS_200=true"
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
		plan.Modules = append(plan.Modules, ModuleActivation{
			ID: module.ID, Key: module.Key, Name: module.Name, Execution: module.Execution,
			Mode: module.Mode, State: state, Reason: reason,
		})
	}
	return plan, nil
}
