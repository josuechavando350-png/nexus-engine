//! Persistent goal state machine. Invalid transitions fail closed.
#![forbid(unsafe_code)]
use nexus_event::{NexusError, Result, Timestamp};
use std::collections::BTreeMap;
use std::sync::RwLock;

#[derive(Debug,Clone,Copy,PartialEq,Eq,PartialOrd,Ord,Hash)]
pub enum GoalStatus{Created,Validated,Planning,Ready,Executing,Waiting,Replanning,Succeeded,Failed,Cancelled,Blocked}
impl GoalStatus{pub fn is_terminal(self)->bool{matches!(self,Self::Succeeded|Self::Failed|Self::Cancelled)}}
#[derive(Debug,Clone,PartialEq,Eq)]
pub struct GoalTransition{pub from:GoalStatus,pub to:GoalStatus,pub at:Timestamp,pub reason:String}
#[derive(Debug,Clone,PartialEq,Eq)]
pub struct Goal{
 pub id:String,pub objective:String,pub constraints:Vec<String>,pub owner:String,pub priority:u8,pub deadline:Option<Timestamp>,pub success_criteria:Vec<String>,pub failure_criteria:Vec<String>,pub policy_scope:String,pub status:GoalStatus,pub parent_id:Option<String>,pub dependencies:Vec<String>,pub retry_budget:u32,pub retries_used:u32,pub history:Vec<GoalTransition>,pub created_at:Timestamp,pub updated_at:Timestamp
}
impl Goal{
 pub fn new(id:impl Into<String>,objective:impl Into<String>,owner:impl Into<String>,now:Timestamp)->Result<Self>{let g=Self{id:id.into(),objective:objective.into(),constraints:vec![],owner:owner.into(),priority:50,deadline:None,success_criteria:vec![],failure_criteria:vec![],policy_scope:"default".into(),status:GoalStatus::Created,parent_id:None,dependencies:vec![],retry_budget:3,retries_used:0,history:vec![],created_at:now,updated_at:now};g.validate()?;Ok(g)}
 pub fn validate(&self)->Result<()>{if self.id.trim().is_empty()||self.objective.trim().is_empty(){return Err(NexusError::schema("goal id/objective required"));}if self.priority>100{return Err(NexusError::invalid("goal priority must be <=100"));}if self.retries_used>self.retry_budget{return Err(NexusError::invalid("goal retries exceed budget"));}if self.updated_at.is_before(self.created_at){return Err(NexusError::invalid("goal updated_at precedes created_at"));}Ok(())}
 pub fn transition(&mut self,to:GoalStatus,at:Timestamp,reason:impl Into<String>)->Result<()> {if at.is_before(self.updated_at){return Err(NexusError::invalid("goal transition time moved backwards"));}if !allowed(self.status,to){return Err(NexusError::invalid(format!("illegal goal transition {:?}->{:?}",self.status,to)));}let from=self.status;self.status=to;self.updated_at=at;self.history.push(GoalTransition{from,to,at,reason:reason.into()});Ok(())}
 pub fn consume_retry(&mut self)->Result<()> {if self.retries_used>=self.retry_budget{return Err(NexusError::exhausted("goal retry budget exhausted"));}self.retries_used+=1;Ok(())}
}
pub fn allowed(a:GoalStatus,b:GoalStatus)->bool{use GoalStatus::*;matches!((a,b),(Created,Validated)|(Validated,Planning)|(Planning,Ready)|(Planning,Blocked)|(Ready,Executing)|(Executing,Waiting)|(Executing,Replanning)|(Executing,Succeeded)|(Executing,Failed)|(Waiting,Executing)|(Waiting,Replanning)|(Waiting,Cancelled)|(Replanning,Ready)|(Replanning,Blocked)|(Blocked,Replanning)|(Blocked,Cancelled)|(Created,Cancelled)|(Validated,Cancelled)|(Planning,Cancelled)|(Ready,Cancelled)|(Executing,Cancelled))}
pub trait GoalStore:Send+Sync{fn put(&self,g:Goal)->Result<()>;fn get(&self,id:&str)->Result<Option<Goal>>;fn list_active(&self)->Result<Vec<Goal>>;}
#[derive(Debug,Default)] pub struct InMemoryGoalStore{inner:RwLock<BTreeMap<String,Goal>>}
impl GoalStore for InMemoryGoalStore{
fn put(&self,g:Goal)->Result<()>{g.validate()?;let mut guard=self.inner.write().map_err(|_|NexusError::adapter("goal lock poisoned"))?;if let Some(existing)=guard.get(&g.id){if existing==&g{return Ok(())}if g.updated_at.is_before(existing.updated_at){return Err(NexusError::invalid("goal store rejected stale update"));}if g.history.len()<existing.history.len(){return Err(NexusError::invalid("goal history cannot shrink"));}}guard.insert(g.id.clone(),g);Ok(())}
fn get(&self,id:&str)->Result<Option<Goal>>{Ok(self.inner.read().map_err(|_|NexusError::adapter("goal lock poisoned"))?.get(id).cloned())}
fn list_active(&self)->Result<Vec<Goal>>{Ok(self.inner.read().map_err(|_|NexusError::adapter("goal lock poisoned"))?.values().filter(|g|!g.status.is_terminal()).cloned().collect())}}

#[cfg(test)]mod tests{use super::*;#[test]fn illegal_transition_rejected(){let mut g=Goal::new("g","inspect","ops",Timestamp::from_millis(0)).unwrap();assert!(g.transition(GoalStatus::Executing,Timestamp::from_millis(1),"skip").is_err());}#[test]fn happy_path(){let mut g=Goal::new("g","inspect","ops",Timestamp::from_millis(0)).unwrap();for s in [GoalStatus::Validated,GoalStatus::Planning,GoalStatus::Ready,GoalStatus::Executing,GoalStatus::Succeeded]{g.transition(s,Timestamp::from_millis(1),"ok").unwrap();}assert!(g.status.is_terminal());}
#[test]fn store_rejects_stale_goal(){let s=InMemoryGoalStore::default();let mut g=Goal::new("g","x","ops",Timestamp::from_millis(10)).unwrap();s.put(g.clone()).unwrap();g.updated_at=Timestamp::from_millis(9);assert!(s.put(g).is_err());}#[test]fn transition_time_cannot_move_backwards(){let mut g=Goal::new("g","inspect","ops",Timestamp::from_millis(10)).unwrap();assert!(g.transition(GoalStatus::Validated,Timestamp::from_millis(9),"stale").is_err());}}
