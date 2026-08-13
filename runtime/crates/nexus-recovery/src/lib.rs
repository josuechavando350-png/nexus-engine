//! Explicit failure classification and bounded recovery policy.
#![forbid(unsafe_code)]
use nexus_event::{NexusError,Result};
#[derive(Debug,Clone,Copy,PartialEq,Eq)]pub enum FailureClass{TransientInfrastructure,DeterministicTask,ModelFailure,InvalidOutput,StaleWorldState,DependencyUnavailable,PolicyDenied,SimulationRejected,ApprovalTimeout,InconsistentObservation,ResourceExhaustion}
#[derive(Debug,Clone,Copy,PartialEq,Eq)]pub enum RecoveryAction{Retry,Backoff,Fallback,Compensate,RereadState,Replan,Suspend,Escalate,FailClosed}
#[derive(Debug,Clone,Copy)]pub struct RecoveryPolicy{pub retry_budget:u32}
impl RecoveryPolicy{pub fn decide(&self,class:FailureClass,retries_used:u32)->Result<RecoveryAction>{use FailureClass::*;use RecoveryAction::*;let a=match class{PolicyDenied|SimulationRejected=>FailClosed,StaleWorldState|InconsistentObservation=>RereadState,InvalidOutput|ModelFailure=>if retries_used<self.retry_budget{Fallback}else{Escalate},TransientInfrastructure|DependencyUnavailable=>if retries_used<self.retry_budget{Backoff}else{Suspend},ApprovalTimeout=>Suspend,ResourceExhaustion=>Suspend,DeterministicTask=>Replan};if matches!(a,Retry|Backoff|Fallback)&&retries_used>=self.retry_budget{return Err(NexusError::exhausted("recovery retry budget exhausted"));}Ok(a)}}
#[cfg(test)]mod tests{use super::*;#[test]fn policy_denial_never_retries(){assert_eq!(RecoveryPolicy{retry_budget:9}.decide(FailureClass::PolicyDenied,0).unwrap(),RecoveryAction::FailClosed);}}
