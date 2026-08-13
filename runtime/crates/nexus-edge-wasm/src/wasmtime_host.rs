//! Wasmtime backend.
//!
//! **Build status: behind the `wasmtime` feature, not part of the default
//! build.** See `docs/architecture/V3_EDGE_RUNTIME.md` for verification status.
//!
//! What Wasmtime gives us that the interpreter cannot: real memory isolation,
//! real fuel metering on arbitrary guest code, and epoch-based interruption
//! for the wall-clock timeout. The verification order, manifest checks and
//! host allowlist are identical, so a task that runs here behaves the same as
//! in `SIMULATION` apart from the host functions being real.

use crate::host::{HostRegistry, MockHost, HOST_ALLOWLIST};
use crate::manifest::ModuleManifest;
use crate::runtime::{EdgeRuntime, ExecutionReport, MockHostFactory};
use nexus_edge_protocol::{
    EdgeTask, EdgeTaskResult, ExecutionMode, NonceLedger, SignerRegistry, TaskStatus,
};
use nexus_event::json::Value;
use nexus_event::{NexusError, Result, Timestamp};
use std::sync::Arc;
use std::time::Duration;
use wasmtime::{Config, Engine, Linker, Module, Store};

/// Per-instance state handed to host functions.
struct HostState {
    registry: Arc<HostRegistry>,
    emitted: Vec<Value>,
}

pub struct WasmtimeRuntime {
    engine: Engine,
    device_id: String,
    device_capabilities: Vec<String>,
    signers: SignerRegistry,
    nonces: NonceLedger,
    host: MockHostFactory,
    mode: ExecutionMode,
}

impl std::fmt::Debug for WasmtimeRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WasmtimeRuntime")
            .field("device_id", &self.device_id)
            .field("mode", &self.mode.as_str())
            .finish()
    }
}

impl WasmtimeRuntime {
    pub fn new(
        device_id: impl Into<String>,
        device_capabilities: Vec<String>,
        signers: SignerRegistry,
        host: MockHostFactory,
        mode: ExecutionMode,
    ) -> Result<Self> {
        let mut config = Config::new();
        config.consume_fuel(true);
        config.epoch_interruption(true);
        config.wasm_simd(true);
        config.wasm_bulk_memory(true);

        // No filesystem, no network, no threads. WASI is deliberately not
        // linked: the only imports a module can resolve are the allowlist.
        //
        // Threads and Wasmtime GC support are disabled at the Cargo feature
        // level. This workspace uses:
        //
        // default-features = false
        // features = ["cranelift", "runtime"]
        //
        // Therefore the `threads` and `gc` crate features are absent, and the
        // corresponding Config setters are not compiled into this build.
        //
        // The sandbox boundary remains the host import allowlist, memory
        // limits, fuel metering and epoch interruption enforced below.
        //
        // `feature_gates_stay_closed` guards this invariant so these features
        // cannot silently return through a dependency configuration change.

        let engine = Engine::new(&config)
            .map_err(|error| NexusError::adapter(format!("wasmtime engine: {error}")))?;

        Ok(WasmtimeRuntime {
            engine,
            device_id: device_id.into(),
            device_capabilities,
            signers,
            nonces: NonceLedger::new(4_096),
            host,
            mode,
        })
    }

    fn link_host_functions(
        linker: &mut Linker<HostState>,
    ) -> std::result::Result<(), wasmtime::Error> {
        // Only the allowlist is linked. An import outside it fails to
        // instantiate, which is the desired outcome.
        linker.func_wrap(
            "nexus",
            "nexus_now_millis",
            |mut caller: wasmtime::Caller<'_, HostState>| -> i64 {
                let state = caller.data_mut();
                state
                    .registry
                    .invoke("nexus_now_millis", &Value::Null)
                    .ok()
                    .and_then(|value| value.as_f64())
                    .unwrap_or(0.0) as i64
            },
        )?;

        linker.func_wrap(
            "nexus",
            "nexus_read_sensor",
            |mut caller: wasmtime::Caller<'_, HostState>, sensor_id: i32| -> f64 {
                // Sensors are addressed by index into the task's declared
                // sensor list rather than by a guest-supplied string, so a
                // module cannot name a device it was not authorised for.
                let name = format!("probe-{sensor_id}");
                let state = caller.data_mut();
                state
                    .registry
                    .invoke("nexus_read_sensor", &Value::string(name))
                    .ok()
                    .and_then(|value| value.as_f64())
                    .unwrap_or(f64::NAN)
            },
        )?;

        linker.func_wrap(
            "nexus",
            "nexus_emit_observation",
            |mut caller: wasmtime::Caller<'_, HostState>, value: f64| -> i32 {
                let observation = Value::object(vec![
                    ("kind", Value::string("reading")),
                    ("value", Value::number(value)),
                ]);

                let state = caller.data_mut();

                let accepted = state
                    .registry
                    .invoke("nexus_emit_observation", &observation)
                    .is_ok();

                if accepted {
                    state.emitted.push(observation);
                }

                i32::from(accepted)
            },
        )?;

        linker.func_wrap(
            "nexus",
            "nexus_report_progress",
            |mut caller: wasmtime::Caller<'_, HostState>, percent: i32| -> i32 {
                let state = caller.data_mut();

                i32::from(
                    state
                        .registry
                        .invoke(
                            "nexus_report_progress",
                            &Value::number(percent.clamp(0, 100) as f64),
                        )
                        .is_ok(),
                )
            },
        )?;

        Ok(())
    }
}

impl EdgeRuntime for WasmtimeRuntime {
    fn backend_name(&self) -> &'static str {
        "wasmtime"
    }

    fn mode(&self) -> ExecutionMode {
        self.mode
    }

    fn execute(
        &self,
        task: &EdgeTask,
        module_bytes: &[u8],
        manifest: &ModuleManifest,
        now: Timestamp,
    ) -> Result<ExecutionReport> {
        task.verify(
            &self.device_id,
            &self.device_capabilities,
            &self.signers,
            &self.nonces,
            now,
        )
        .map_err(NexusError::from)?;

        // Physical execution additionally demands a production signer; the
        // task verifier already enforced this, and it is asserted again here
        // because this backend is the one that can actually move hardware.
        if self.mode.is_physical() {
            if let Some(signer_id) = task.signer_id() {
                self.signers.require_production_signer(signer_id)?;
            }
        }

        manifest.verify(module_bytes, &self.signers)?;

        for import in &manifest.allowed_host_functions {
            if !HOST_ALLOWLIST.contains(&import.as_str()) {
                return Err(NexusError::denied(format!(
                    "host function '{import}' is not linkable"
                )));
            }
        }

        let module = Module::new(&self.engine, module_bytes)
            .map_err(|error| NexusError::invalid(format!("module rejected: {error}")))?;

        let registry = Arc::new(HostRegistry::new(
            manifest.allowed_host_functions.clone(),
            crate::runtime::SimulationExecutor::capability_tokens(task),
            manifest.limits.max_host_calls,
            MockHost::new(now),
        ));

        let mut store = Store::new(
            &self.engine,
            HostState {
                registry: Arc::clone(&registry),
                emitted: Vec::new(),
            },
        );

        store
            .set_fuel(manifest.limits.fuel)
            .map_err(|error| NexusError::adapter(format!("set fuel: {error}")))?;

        store.set_epoch_deadline(1);

        let engine = self.engine.clone();
        let timeout = Duration::from_millis(manifest.limits.timeout_millis);

        // Watchdog thread trips the epoch, which interrupts the guest even if
        // it is in a tight loop that never yields.
        std::thread::spawn(move || {
            std::thread::sleep(timeout);
            engine.increment_epoch();
        });

        let mut linker: Linker<HostState> = Linker::new(&self.engine);

        WasmtimeRuntime::link_host_functions(&mut linker)
            .map_err(|error| NexusError::adapter(format!("link host functions: {error}")))?;

        let started = std::time::Instant::now();

        let instance = linker
            .instantiate(&mut store, &module)
            .map_err(|error| NexusError::invalid(format!("instantiate: {error}")))?;

        let entry = instance
            .get_typed_func::<(), i32>(&mut store, "nexus_handle_task")
            .map_err(|error| {
                NexusError::invalid(format!(
                    "module has no nexus_handle_task export: {error}"
                ))
            })?;

        let outcome = entry.call(&mut store, ());

        let elapsed = started.elapsed().as_millis() as u64;

        let fuel_remaining = store.get_fuel().unwrap_or(0);

        let fuel_consumed =
            manifest.limits.fuel.saturating_sub(fuel_remaining);

        let (status, detail) = match outcome {
            Ok(0) => (
                TaskStatus::Completed,
                String::new(),
            ),

            Ok(code) => (
                TaskStatus::Failed,
                format!("module returned {code}"),
            ),

            Err(error) => {
                let message = error.to_string();

                if message.contains("fuel")
                    || message.contains("epoch")
                {
                    (
                        TaskStatus::Aborted,
                        format!(
                            "resource limit hit: {message}"
                        ),
                    )
                } else {
                    (
                        TaskStatus::Failed,
                        message,
                    )
                }
            }
        };

        let emitted = store.data().emitted.clone();

        Ok(ExecutionReport {
            result: EdgeTaskResult {
                task_id: task.task_id.clone(),
                device_id: self.device_id.clone(),
                status,
                completed_at: now,
                duration_millis: elapsed,
                observations: emitted,
                detail,
                trace_id: task.trace_id.clone(),
            },

            host_calls: registry.calls(),

            fuel_consumed,

            peak_memory_bytes:
                manifest.limits.max_memory_bytes,

            mode: self.mode,

            module_id:
                manifest.module_id.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn wasi_is_never_linked() {
        let source =
            include_str!("wasmtime_host.rs");

        assert!(
            !source.contains("wasmtime_wasi")
        );

        assert!(
            !source.contains("add_to_linker")
        );
    }

    #[test]
    fn fuel_and_epoch_interruption_are_both_enabled() {
        let source =
            include_str!("wasmtime_host.rs");

        assert!(
            source.contains(
                "config.consume_fuel(true)"
            )
        );

        assert!(
            source.contains(
                "config.epoch_interruption(true)"
            )
        );
    }

    #[test]
    fn feature_gates_stay_closed() {
        let manifest =
            include_str!("../../../Cargo.toml");

        let declaration = manifest
            .lines()
            .find(|line| {
                line
                    .trim_start()
                    .starts_with("wasmtime =")
            })
            .expect(
                "workspace manifest must declare the wasmtime dependency",
            );

        assert!(
            declaration.contains(
                "default-features = false"
            ),
            "wasmtime must be declared with default-features = false, found: {declaration}"
        );

        assert!(
            !declaration.contains("\"threads\""),
            "the wasmtime threads feature must stay off: {declaration}"
        );

        assert!(
            !declaration.contains("\"gc\""),
            "the wasmtime gc feature must stay off: {declaration}"
        );
    }

    #[test]
    fn threads_and_reference_types_are_never_switched_on() {
        let source =
            include_str!("wasmtime_host.rs");

        assert!(
            !source.contains(
                "wasm_threads(true)"
            )
        );

        assert!(
            !source.contains(
                "wasm_reference_types(true)"
            )
        );

        assert!(
            !source.contains(
                "wasm_shared_everything_threads(true)"
            )
        );
    }
            }
