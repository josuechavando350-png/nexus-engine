use crate::{ChainDomain, Hash32, ProtocolFamily};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AdapterCapability {
    MarketDiscovery,
    StateReconstruction,
    PositionDiscovery,
    OracleObservation,
    TokenAdmission,
    CapitalCensus,
    RouteQuotation,
    ExecutionSimulation,
    CompetitionObservation,
    EconomicClassification,
}

impl AdapterCapability {
    pub const fn code(self) -> &'static str {
        match self {
            Self::MarketDiscovery => "MARKET_DISCOVERY",
            Self::StateReconstruction => "STATE_RECONSTRUCTION",
            Self::PositionDiscovery => "POSITION_DISCOVERY",
            Self::OracleObservation => "ORACLE_OBSERVATION",
            Self::TokenAdmission => "TOKEN_ADMISSION",
            Self::CapitalCensus => "CAPITAL_CENSUS",
            Self::RouteQuotation => "ROUTE_QUOTATION",
            Self::ExecutionSimulation => "EXECUTION_SIMULATION",
            Self::CompetitionObservation => "COMPETITION_OBSERVATION",
            Self::EconomicClassification => "ECONOMIC_CLASSIFICATION",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CapabilityScope {
    chain: ChainDomain,
    protocol: ProtocolFamily,
    protocol_semantics_version: u32,
}

impl CapabilityScope {
    pub fn new(
        chain: ChainDomain,
        protocol: ProtocolFamily,
        protocol_semantics_version: u32,
    ) -> Result<Self, CapabilityError> {
        if protocol_semantics_version == 0 {
            return Err(CapabilityError::ZeroProtocolSemanticsVersion);
        }
        Ok(Self {
            chain,
            protocol,
            protocol_semantics_version,
        })
    }

    pub const fn chain(&self) -> &ChainDomain {
        &self.chain
    }

    pub const fn protocol(&self) -> ProtocolFamily {
        self.protocol
    }

    pub const fn protocol_semantics_version(&self) -> u32 {
        self.protocol_semantics_version
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterDeclaration {
    adapter_id: Hash32,
    scope: CapabilityScope,
    capabilities: BTreeSet<AdapterCapability>,
}

impl AdapterDeclaration {
    pub fn new(
        adapter_id: Hash32,
        scope: CapabilityScope,
        capabilities: Vec<AdapterCapability>,
    ) -> Result<Self, CapabilityError> {
        let capabilities = capabilities.into_iter().collect::<BTreeSet<_>>();
        if capabilities.is_empty() {
            return Err(CapabilityError::EmptyCapabilitySet);
        }
        Ok(Self {
            adapter_id,
            scope,
            capabilities,
        })
    }

    pub const fn adapter_id(&self) -> Hash32 {
        self.adapter_id
    }

    pub const fn scope(&self) -> &CapabilityScope {
        &self.scope
    }

    pub fn capabilities(&self) -> &BTreeSet<AdapterCapability> {
        &self.capabilities
    }

    pub fn supports(&self, capability: AdapterCapability) -> bool {
        self.capabilities.contains(&capability)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedCapability {
    scope: CapabilityScope,
    capability: AdapterCapability,
    scope_declared: bool,
}

impl UnsupportedCapability {
    pub const fn scope(&self) -> &CapabilityScope {
        &self.scope
    }

    pub const fn capability(&self) -> AdapterCapability {
        self.capability
    }

    pub const fn scope_declared(&self) -> bool {
        self.scope_declared
    }

    pub const fn reason_code(&self) -> &'static str {
        "UNSUPPORTED_CAPABILITY"
    }
}

#[derive(Debug, Default)]
pub struct CapabilityMatrix {
    declarations: BTreeMap<CapabilityScope, AdapterDeclaration>,
}

impl CapabilityMatrix {
    pub fn declare(&mut self, declaration: AdapterDeclaration) -> Result<(), CapabilityError> {
        let scope = declaration.scope().clone();
        match self.declarations.get(&scope) {
            Some(existing) if existing == &declaration => Ok(()),
            Some(_) => Err(CapabilityError::ConflictingDeclaration),
            None => {
                self.declarations.insert(scope, declaration);
                Ok(())
            }
        }
    }

    pub fn require(
        &self,
        scope: &CapabilityScope,
        capability: AdapterCapability,
    ) -> Result<&AdapterDeclaration, UnsupportedCapability> {
        let Some(declaration) = self.declarations.get(scope) else {
            return Err(UnsupportedCapability {
                scope: scope.clone(),
                capability,
                scope_declared: false,
            });
        };
        if !declaration.supports(capability) {
            return Err(UnsupportedCapability {
                scope: scope.clone(),
                capability,
                scope_declared: true,
            });
        }
        Ok(declaration)
    }

    pub fn declaration(&self, scope: &CapabilityScope) -> Option<&AdapterDeclaration> {
        self.declarations.get(scope)
    }

    pub fn len(&self) -> usize {
        self.declarations.len()
    }

    pub fn is_empty(&self) -> bool {
        self.declarations.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapabilityError {
    ZeroProtocolSemanticsVersion,
    EmptyCapabilitySet,
    ConflictingDeclaration,
}

impl Display for CapabilityError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ZeroProtocolSemanticsVersion => {
                formatter.write_str("protocol semantics version must not be zero")
            }
            Self::EmptyCapabilitySet => {
                formatter.write_str("adapter declaration must expose at least one capability")
            }
            Self::ConflictingDeclaration => {
                formatter.write_str("conflicting adapter declaration for the same scope")
            }
        }
    }
}

impl std::error::Error for CapabilityError {}
