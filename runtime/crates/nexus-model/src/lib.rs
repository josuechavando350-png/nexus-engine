//! Provider-independent inference contracts and policy-neutral routing.
#![forbid(unsafe_code)]

use nexus_event::{NexusError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Modality {
    Text,
    Vision,
    Audio,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCapabilities {
    pub structured_output: bool,
    pub tool_use: bool,
    pub local: bool,
    pub modalities: Vec<Modality>,
    pub max_context_tokens: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InferenceRequest {
    pub task_code: String,
    pub prompt: String,
    pub required_schema: String,
    pub privacy_scope: String,
    pub max_output_tokens: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InferenceResponse {
    pub provider_id: String,
    pub model_id: String,
    pub structured_output: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

pub trait ModelProvider: Send + Sync {
    fn provider_id(&self) -> &str;
    fn capabilities(&self) -> ModelCapabilities;
    fn infer(&self, req: &InferenceRequest) -> Result<InferenceResponse>;
}

#[derive(Debug, Clone)]
pub struct DeterministicProvider {
    pub id: String,
    pub output: String,
}

impl ModelProvider for DeterministicProvider {
    fn provider_id(&self) -> &str {
        &self.id
    }

    fn capabilities(&self) -> ModelCapabilities {
        ModelCapabilities {
            structured_output: true,
            tool_use: false,
            local: true,
            modalities: vec![Modality::Text],
            max_context_tokens: 4096,
        }
    }

    fn infer(&self, _: &InferenceRequest) -> Result<InferenceResponse> {
        Ok(InferenceResponse {
            provider_id: self.id.clone(),
            model_id: "deterministic-fixture-v1".into(),
            structured_output: self.output.clone(),
            input_tokens: None,
            output_tokens: None,
        })
    }
}

#[derive(Default)]
pub struct ModelRouter {
    providers: Vec<Box<dyn ModelProvider>>,
}

impl ModelRouter {
    pub fn register(&mut self, p: Box<dyn ModelProvider>) {
        self.providers.push(p)
    }

    pub fn select(
        &self,
        require_local: bool,
        require_structured: bool,
    ) -> Result<&dyn ModelProvider> {
        self.providers
            .iter()
            .find(|p| {
                let c = p.capabilities();
                (!require_local || c.local) && (!require_structured || c.structured_output)
            })
            .map(|p| p.as_ref())
            .ok_or_else(|| NexusError::not_found("no model provider matches requirements"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_is_capability_based() {
        let mut r = ModelRouter::default();

        r.register(Box::new(DeterministicProvider {
            id: "fixture".into(),
            output: "{}".into(),
        }));

        assert_eq!(r.select(true, true).unwrap().provider_id(), "fixture");
    }
}
