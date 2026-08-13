//! Independent structured evaluation; evaluators cannot grant execution authority.
#![forbid(unsafe_code)]
use nexus_event::{NexusError,Result};use nexus_goal::Goal;use nexus_planner::Plan;
#[derive(Debug,Clone,PartialEq)]pub struct Evaluation{pub goal_satisfaction:f64,pub factual_grounding:f64,pub plan_consistency:f64,pub confidence:f64,pub issue_codes:Vec<String>}
impl Evaluation{pub fn validate(&self)->Result<()>{for value in [self.goal_satisfaction,self.factual_grounding,self.plan_consistency,self.confidence]{if !(0.0..=1.0).contains(&value)||!value.is_finite(){return Err(NexusError::invalid("evaluation score outside finite [0,1]"));}}Ok(())}}
pub trait GoalEvaluator:Send+Sync{fn evaluate(&self,goal:&Goal,plan:&Plan,evidence:&[String])->Result<Evaluation>;}
#[derive(Debug,Default)]pub struct DeterministicEvaluator;
impl GoalEvaluator for DeterministicEvaluator{fn evaluate(&self,_:&Goal,plan:&Plan,evidence:&[String])->Result<Evaluation>{let evaluation=Evaluation{goal_satisfaction:if plan.nodes.is_empty(){0.0}else{0.5},factual_grounding:if evidence.is_empty(){0.0}else{1.0},plan_consistency:if plan.validate().is_ok(){1.0}else{0.0},confidence:1.0,issue_codes:vec![]};evaluation.validate()?;Ok(evaluation)}}
