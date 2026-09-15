package core

import "testing"

func TestActivationPlanCoversAllTwoHundredModulesWhenEnabled(t *testing.T) {
	plan, err := ActivationPlan("walle-proof-probe", true)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Bypassed || plan.ModuleCount != 200 || len(plan.Modules) != 200 {
		t.Fatalf("plan=%+v", plan)
	}
	if plan.Modules[0].State != "ON" {
		t.Fatalf("module 1=%s", plan.Modules[0].State)
	}
	if plan.Modules[18].ID != 19 || plan.Modules[18].State != "GATED" {
		t.Fatalf("module 19=%+v", plan.Modules[18])
	}
	if plan.Modules[199].ID != 200 {
		t.Fatalf("module 200=%+v", plan.Modules[199])
	}
}

func TestActivationPlanFailClosesOperatorMutationModules(t *testing.T) {
	plan, err := ActivationPlan("walle-proof-probe", true)
	if err != nil {
		t.Fatal(err)
	}
	byID := make(map[int]ModuleActivation, len(plan.Modules))
	for _, module := range plan.Modules {
		byID[module.ID] = module
	}
	for _, id := range []int{18, 21, 23, 25, 50} {
		module := byID[id]
		if module.State != "ADVISORY" || module.Mode != "advisory-only" {
			t.Fatalf("module %d must be advisory: %+v", id, module)
		}
		if module.CatalogMode != "compliant" {
			t.Fatalf("module %d catalog provenance drifted: %+v", id, module)
		}
	}
	if module := byID[23]; module.Reason == "" {
		t.Fatalf("module 23 must carry explicit Google/backlink safety reason: %+v", module)
	}
}

func TestActivationPlanPreservesExistingPolicyGates(t *testing.T) {
	plan, err := ActivationPlan("walle-proof-probe", true)
	if err != nil {
		t.Fatal(err)
	}
	byID := make(map[int]ModuleActivation, len(plan.Modules))
	for _, module := range plan.Modules {
		byID[module.ID] = module
	}
	if byID[27].State != "GATED" || byID[27].Mode != "eligibility-gated" {
		t.Fatalf("Google Indexing API eligibility gate drifted: %+v", byID[27])
	}
	if byID[30].State != "ADVISORY" || byID[30].Mode != "advisory-only" {
		t.Fatalf("disavow advisory gate drifted: %+v", byID[30])
	}
	if byID[31].State != "GATED" || byID[31].Mode != "experiment-safe" {
		t.Fatalf("title experiment gate drifted: %+v", byID[31])
	}
	if byID[39].State != "GATED" || byID[39].Mode != "consent-aware" {
		t.Fatalf("consent gate drifted: %+v", byID[39])
	}
}

func TestActivationPlanOffIsLazyBypass(t *testing.T) {
	plan, err := ActivationPlan("client", false)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Enabled || !plan.Bypassed || plan.ModuleCount != 0 || len(plan.Modules) != 0 {
		t.Fatalf("expected lazy bypass without module initialization: %+v", plan)
	}
}
