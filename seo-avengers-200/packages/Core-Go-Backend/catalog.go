package core

import (
	"embed"
	"encoding/json"
	"fmt"
	"sync"
)

const SeoAvengersModuleCount = 200

//go:embed module-catalog.json
var catalogFS embed.FS

// ModuleDefinition is the deterministic control-plane description for one module.
type ModuleDefinition struct {
	ID                  int    `json:"id"`
	Key                 string `json:"key"`
	Name                string `json:"name"`
	Block               string `json:"block"`
	Execution           string `json:"execution"`
	ExecutionLayer      string `json:"execution_layer"`
	Category            string `json:"category"`
	ContractType        string `json:"contract_type"`
	FailSafeStatus      string `json:"fail_safe_status"`
	RequestPathBlocking bool   `json:"request_path_blocking"`
	DeterminismContract string `json:"determinism_contract"`
	Mode                string `json:"mode"`
	Note                string `json:"note"`
}

var (
	catalogOnce sync.Once
	catalogData []ModuleDefinition
	catalogErr  error
)

func ModuleCatalog() ([]ModuleDefinition, error) {
	catalogOnce.Do(func() {
		b, err := catalogFS.ReadFile("module-catalog.json")
		if err != nil {
			catalogErr = err
			return
		}
		if err := json.Unmarshal(b, &catalogData); err != nil {
			catalogErr = err
			return
		}
		if len(catalogData) != SeoAvengersModuleCount {
			catalogErr = fmt.Errorf("module catalog: expected %d entries, got %d", SeoAvengersModuleCount, len(catalogData))
			return
		}
		for i, m := range catalogData {
			if m.ID != i+1 {
				catalogErr = fmt.Errorf("module catalog: non-contiguous id at index %d", i)
				return
			}
			if m.RequestPathBlocking {
				catalogErr = fmt.Errorf("module %s violates non-blocking contract", m.Key)
				return
			}
			if m.ExecutionLayer == "" || m.Category == "" || m.ContractType == "" || m.FailSafeStatus == "" {
				catalogErr = fmt.Errorf("module %s is missing source contract metadata", m.Key)
				return
			}
			if m.DeterminismContract == "" {
				catalogErr = fmt.Errorf("module %s is missing determinism contract", m.Key)
				return
			}
		}
	})
	out := make([]ModuleDefinition, len(catalogData))
	copy(out, catalogData)
	return out, catalogErr
}
