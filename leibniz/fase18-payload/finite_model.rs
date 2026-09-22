//! Exhaustive finite *standard-model* interpreter, independent of the HOL proof checker.
//!
//! This is a bounded semantic oracle, NOT a decision procedure for unrestricted
//! higher-order validity. A false closed formula is a genuine counterexample in
//! the constructed standard model; true on the tested models is NOT a proof.
use crate::hol::{Expr, Ty};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Individual(usize),
    Truth(bool),
    /// Extensional table, indexed by the canonical order of the argument domain.
    Function(Vec<Value>),
}

#[derive(Clone, Debug)]
pub struct FiniteModel {
    individuals: usize,
    max_domain: usize,
    max_steps: usize,
    constants: BTreeMap<String, (Ty, Value)>,
}

struct Fuel { left: usize }
impl Fuel {
    fn tick(&mut self) -> Result<(), String> {
        self.left = self.left.checked_sub(1).ok_or("finite-model work budget exhausted")?;
        Ok(())
    }
}

impl FiniteModel {
    /// Full finite standard models; functional domains contain EVERY function.
    pub fn new(individuals: usize, max_domain: usize, max_steps: usize) -> Result<Self, String> {
        if !(1..=64).contains(&individuals) || max_domain == 0 || max_steps == 0 {
            return Err("finite-model budgets and individual count must be positive".into());
        }
        if individuals > max_domain {
            return Err("individual domain exceeds finite-model cap".into());
        }
        Ok(Self { individuals, max_domain, max_steps, constants: BTreeMap::new() })
    }

    pub fn set_constant(&mut self, name: &str, ty: Ty, value: Value) -> Result<(), String> {
        if name.trim().is_empty() || self.constants.contains_key(name) {
            return Err("finite-model constant name must be nonempty and unique".into());
        }
        let mut fuel = Fuel { left: self.max_steps };
        if !self.values(&ty, &mut fuel, 0)?.contains(&value) {
            return Err("finite-model constant is outside its typed domain".into());
        }
        self.constants.insert(name.to_owned(), (ty, value));
        Ok(())
    }

    /// Enumerate a domain with a strict cardinality AND computation budget.
    pub fn domain(&self, ty: &Ty) -> Result<Vec<Value>, String> {
        self.values(ty, &mut Fuel { left: self.max_steps }, 0)
    }

    fn values(&self, ty: &Ty, fuel: &mut Fuel, depth: usize) -> Result<Vec<Value>, String> {
        fuel.tick()?;
        if depth > 64 { return Err("finite-model type depth exceeded".into()); }
        match ty {
            Ty::Individual => Ok((0..self.individuals).map(Value::Individual).collect()),
            Ty::Prop => {
                if self.max_domain < 2 { return Err("Boolean domain exceeds cap".into()); }
                Ok(vec![Value::Truth(false), Value::Truth(true)])
            }
            Ty::Arrow(from, to) => {
                let inputs = self.values(from, fuel, depth + 1)?;
                let outputs = self.values(to, fuel, depth + 1)?;
                // Guard BEFORE allocation or enumeration: |B|^|A|.
                let mut cardinality = 1usize;
                for _ in &inputs {
                    cardinality = cardinality.checked_mul(outputs.len())
                        .ok_or("finite-model function-domain cardinality overflow")?;
                    if cardinality > self.max_domain {
                        return Err("finite-model function domain exceeds cap".into());
                    }
                    fuel.tick()?;
                }
                let mut tables = vec![Vec::new()];
                for _ in &inputs {
                    let mut next = Vec::with_capacity(cardinality);
                    for prefix in tables {
                        for result in &outputs {
                            fuel.tick()?;
                            let mut row = prefix.clone();
                            row.push(result.clone());
                            next.push(row);
                        }
                    }
                    tables = next;
                }
                Ok(tables.into_iter().map(Value::Function).collect())
            }
        }
    }

    fn ty_of(&self, e: &Expr, env: &mut Vec<(String, Ty)>, fuel: &mut Fuel,
             depth: usize) -> Result<Ty, String> {
        fuel.tick()?;
        if depth > 128 { return Err("finite-model expression depth exceeded".into()); }
        match e {
            Expr::Var(name, ty) => match env.iter().rev().find(|(n, _)| n == name) {
                Some((_, declared)) if declared == ty => Ok(ty.clone()),
                _ => Err("finite-model unbound or mistyped variable".into()),
            },
            Expr::Const(name, ty) => match self.constants.get(name) {
                Some((declared, _)) if declared == ty => Ok(ty.clone()),
                _ => Err("finite-model missing or mistyped constant".into()),
            },
            Expr::False => Ok(Ty::Prop),
            Expr::Lam(name, ty, body) | Expr::Forall(name, ty, body)
                | Expr::Exists(name, ty, body) => {
                if name.trim().is_empty() || env.iter().any(|(n, _)| n == name) {
                    return Err("finite-model invalid or shadowed binder".into());
                }
                self.values(ty, fuel, depth + 1)?;
                env.push((name.clone(), ty.clone()));
                let body_ty = self.ty_of(body, env, fuel, depth + 1)?;
                env.pop();
                match e {
                    Expr::Lam(..) => Ok(Ty::Arrow(Box::new(ty.clone()), Box::new(body_ty))),
                    _ if body_ty == Ty::Prop => Ok(Ty::Prop),
                    _ => Err("finite-model quantifier body is not a proposition".into()),
                }
            }
            Expr::App(function, argument) => {
                let f = self.ty_of(function, env, fuel, depth + 1)?;
                let arg = self.ty_of(argument, env, fuel, depth + 1)?;
                if let Ty::Arrow(domain, codomain) = f {
                    if *domain == arg { return Ok(*codomain); }
                }
                Err("finite-model ill-typed application".into())
            }
            Expr::Imp(left, right) | Expr::And(left, right) => {
                if self.ty_of(left, env, fuel, depth + 1)? == Ty::Prop
                    && self.ty_of(right, env, fuel, depth + 1)? == Ty::Prop {
                    Ok(Ty::Prop)
                } else { Err("finite-model ill-typed connective".into()) }
            }
            Expr::Equal(left, right) => {
                if self.ty_of(left, env, fuel, depth + 1)?
                    == self.ty_of(right, env, fuel, depth + 1)? {
                    Ok(Ty::Prop)
                } else { Err("finite-model ill-typed equality".into()) }
            }
        }
    }

    /// Interpret a CLOSED, fully typed proposition in a specified finite model.
    pub fn evaluate(&self, expression: &Expr) -> Result<bool, String> {
        let mut fuel = Fuel { left: self.max_steps };
        if self.ty_of(expression, &mut Vec::new(), &mut fuel, 0)? != Ty::Prop {
            return Err("finite-model expected a closed proposition".into());
        }
        match self.eval(expression, &mut Vec::new(), &mut fuel, 0)? {
            Value::Truth(result) => Ok(result),
            _ => Err("finite-model evaluation did not return truth".into()),
        }
    }

    fn eval(&self, e: &Expr, env: &mut Vec<(String, Ty, Value)>, fuel: &mut Fuel,
            depth: usize) -> Result<Value, String> {
        fuel.tick()?;
        if depth > 128 { return Err("finite-model evaluation depth exceeded".into()); }
        let child = depth + 1;
        match e {
            Expr::Var(name, _) => env.iter().rev().find(|(n, _, _)| n == name)
                .map(|(_, _, value)| value.clone()).ok_or("finite-model unbound variable".into()),
            Expr::Const(name, _) => self.constants.get(name).map(|(_, value)| value.clone())
                .ok_or("finite-model missing constant".into()),
            Expr::False => Ok(Value::Truth(false)),
            Expr::Lam(name, ty, body) => {
                let mut results = Vec::new();
                for value in self.values(ty, fuel, child)? {
                    env.push((name.clone(), ty.clone(), value));
                    let output = self.eval(body, env, fuel, child);
                    env.pop();
                    results.push(output?);
                }
                Ok(Value::Function(results))
            }
            Expr::App(function, argument) => {
                let mut types: Vec<(String, Ty)> = env.iter().map(|(n, t, _)| (n.clone(), t.clone())).collect();
                let function_ty = self.ty_of(function, &mut types, fuel, child)?;
                let Ty::Arrow(input_ty, _) = function_ty else {
                    return Err("finite-model application lacks function type".into());
                };
                let function_value = self.eval(function, env, fuel, child)?;
                let arg_value = self.eval(argument, env, fuel, child)?;
                let position = self.values(&input_ty, fuel, child)?.iter()
                    .position(|candidate| candidate == &arg_value)
                    .ok_or("finite-model function argument outside domain")?;
                match function_value {
                    Value::Function(results) => results.get(position).cloned()
                        .ok_or("finite-model malformed function table".into()),
                    _ => Err("finite-model application of non-function".into()),
                }
            }
            Expr::Imp(a, b) => {
                let left = self.eval(a, env, fuel, child)?;
                let right = self.eval(b, env, fuel, child)?;
                match (left, right) {
                    (Value::Truth(x), Value::Truth(y)) => Ok(Value::Truth(!x || y)),
                    _ => Err("finite-model implication operands are not truth values".into()),
                }
            }
            Expr::And(a, b) => {
                let left = self.eval(a, env, fuel, child)?;
                let right = self.eval(b, env, fuel, child)?;
                match (left, right) {
                    (Value::Truth(x), Value::Truth(y)) => Ok(Value::Truth(x && y)),
                    _ => Err("finite-model conjunction operands are not truth values".into()),
                }
            }
            Expr::Equal(a, b) => Ok(Value::Truth(
                self.eval(a, env, fuel, child)? == self.eval(b, env, fuel, child)?)),
            Expr::Forall(name, ty, body) | Expr::Exists(name, ty, body) => {
                let universal = matches!(e, Expr::Forall(..));
                let mut aggregate = universal;
                for value in self.values(ty, fuel, child)? {
                    env.push((name.clone(), ty.clone(), value));
                    let evaluated = self.eval(body, env, fuel, child);
                    env.pop();
                    let Value::Truth(truth) = evaluated? else {
                        return Err("finite-model quantified body is not truth".into());
                    };
                    if universal { aggregate &= truth; } else { aggregate |= truth; }
                }
                Ok(Value::Truth(aggregate))
            }
        }
    }
}
