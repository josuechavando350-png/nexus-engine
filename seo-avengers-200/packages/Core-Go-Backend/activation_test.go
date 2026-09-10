package core

import "testing"

func TestActivationPlanCoversAllTwoHundredModulesWhenEnabled(t *testing.T) {
	plan, err := ActivationPlan("nexus-bot-studio", true)
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

func TestActivationPlanOffIsLazyBypass(t *testing.T) {
	plan, err := ActivationPlan("client", false)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Enabled || !plan.Bypassed || plan.ModuleCount != 0 || len(plan.Modules) != 0 {
		t.Fatalf("expected lazy bypass without module initialization: %+v", plan)
	}
}
