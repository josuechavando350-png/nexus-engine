//! A checking kernel for classical Church-style simple type theory.
//!
//! Type variables are not needed: quantification ranges over terms of ANY
//! constructed simple type, including predicates and predicates-of-predicates.
//! A proof is checked; missing proofs are not searched for or asserted to exist.
//! Correctness is relative to typed constants, open hypotheses and classical
//! higher-order (general/Henkin) models. No source facts are fabricated.

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ty {
    Individual,
    Prop,
    Arrow(Box<Ty>, Box<Ty>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Expr {
    Var(String, Ty),
    Const(String, Ty),
    Lam(String, Ty, Box<Expr>),
    App(Box<Expr>, Box<Expr>),
    False,
    Imp(Box<Expr>, Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Forall(String, Ty, Box<Expr>),
    Exists(String, Ty, Box<Expr>),
    Equal(Box<Expr>, Box<Expr>),
}

#[derive(Clone, Debug)]
pub enum Derivation {
    Hypothesis(usize),
    ImpIntro {
        assumption: Expr,
        body: Box<Derivation>,
    },
    ImpElim(Box<Derivation>, Box<Derivation>),
    AndIntro(Box<Derivation>, Box<Derivation>),
    AndLeft(Box<Derivation>),
    AndRight(Box<Derivation>),
    ForallIntro {
        variable: String,
        ty: Ty,
        body: Box<Derivation>,
    },
    ForallElim {
        universal: Box<Derivation>,
        witness: Expr,
    },
    EqualRefl(Expr),
    FalseElim {
        contradiction: Box<Derivation>,
        conclusion: Expr,
    },
    ExistsIntro {
        variable: String,
        ty: Ty,
        body: Expr,
        witness: Expr,
        proof: Box<Derivation>,
    },
    ExistsElim {
        existential: Box<Derivation>,
        eigenvariable: String,
        body: Box<Derivation>,
    },
    FunctionExtensionality {
        left: Expr,
        right: Expr,
        pointwise: Box<Derivation>,
    },
    PropositionExtensionality {
        left: Expr,
        right: Expr,
        forward: Box<Derivation>,
        reverse: Box<Derivation>,
    },
    EqualElim {
        equality: Box<Derivation>,
        predicate: Expr,
        proof: Box<Derivation>,
    },
    Classical {
        proposition: Expr,
        double_negation: Box<Derivation>,
    },
}

#[derive(Clone, Copy, Debug)]
pub struct Budget {
    pub max_nodes: usize,
    pub max_reductions: usize,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            max_nodes: 100_000,
            max_reductions: 10_000,
        }
    }
}

fn valid_type(ty: &Ty, depth: usize) -> bool {
    if depth > 128 {
        return false;
    }
    match ty {
        Ty::Individual | Ty::Prop => true,
        Ty::Arrow(a, b) => valid_type(a, depth + 1) && valid_type(b, depth + 1),
    }
}

fn free(name: &str, e: &Expr) -> bool {
    use Expr::*;
    match e {
        Var(n, _) => n == name,
        Const(_, _) | False => false,
        Lam(n, _, b) | Forall(n, _, b) | Exists(n, _, b) => n != name && free(name, b),
        App(a, b) | Imp(a, b) | And(a, b) | Equal(a, b) => free(name, a) || free(name, b),
    }
}

fn names(e: &Expr, into: &mut std::collections::BTreeSet<String>) {
    use Expr::*;
    match e {
        Var(n, _) | Const(n, _) => {
            into.insert(n.clone());
        }
        Lam(n, _, b) | Forall(n, _, b) | Exists(n, _, b) => {
            into.insert(n.clone());
            names(b, into);
        }
        False => (),
        App(a, b) | Imp(a, b) | And(a, b) | Equal(a, b) => {
            names(a, into);
            names(b, into);
        }
    }
}
fn fresh(a: &Expr, b: &Expr) -> String {
    let mut existing = std::collections::BTreeSet::new();
    names(a, &mut existing);
    names(b, &mut existing);
    for i in 0..=existing.len() {
        let candidate = format!("__hol_bound_{i}");
        if !existing.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("there is always a fresh name")
}

// Change precisely the free occurrences of a binder's variable; inner
// binders with the same name shadow it.
fn rename(e: &Expr, old: &str, new: &str) -> Expr {
    use Expr::*;
    match e {
        Var(n, t) if n == old => Var(new.into(), t.clone()),
        Var(..) | Const(..) | False => e.clone(),
        Lam(n, t, b) if n == old => Lam(n.clone(), t.clone(), b.clone()),
        Forall(n, t, b) if n == old => Forall(n.clone(), t.clone(), b.clone()),
        Exists(n, t, b) if n == old => Exists(n.clone(), t.clone(), b.clone()),
        Lam(n, t, b) => Lam(n.clone(), t.clone(), Box::new(rename(b, old, new))),
        Forall(n, t, b) => Forall(n.clone(), t.clone(), Box::new(rename(b, old, new))),
        Exists(n, t, b) => Exists(n.clone(), t.clone(), Box::new(rename(b, old, new))),
        App(a, b) => App(Box::new(rename(a, old, new)), Box::new(rename(b, old, new))),
        Imp(a, b) => Imp(Box::new(rename(a, old, new)), Box::new(rename(b, old, new))),
        And(a, b) => And(Box::new(rename(a, old, new)), Box::new(rename(b, old, new))),
        Equal(a, b) => Equal(Box::new(rename(a, old, new)), Box::new(rename(b, old, new))),
    }
}

fn substitute(e: &Expr, name: &str, value: &Expr) -> Expr {
    use Expr::*;
    match e {
        Var(n, _) if n == name => value.clone(),
        Var(..) | Const(..) | False => e.clone(),
        Lam(n, t, b) if n == name => Lam(n.clone(), t.clone(), b.clone()),
        Forall(n, t, b) if n == name => Forall(n.clone(), t.clone(), b.clone()),
        Exists(n, t, b) if n == name => Exists(n.clone(), t.clone(), b.clone()),
        Lam(n, t, b) if free(n, value) => {
            let f = fresh(b, value);
            Lam(
                f.clone(),
                t.clone(),
                Box::new(substitute(&rename(b, n, &f), name, value)),
            )
        }
        Forall(n, t, b) if free(n, value) => {
            let f = fresh(b, value);
            Forall(
                f.clone(),
                t.clone(),
                Box::new(substitute(&rename(b, n, &f), name, value)),
            )
        }
        Exists(n, t, b) if free(n, value) => {
            let f = fresh(b, value);
            Exists(
                f.clone(),
                t.clone(),
                Box::new(substitute(&rename(b, n, &f), name, value)),
            )
        }
        Lam(n, t, b) => Lam(n.clone(), t.clone(), Box::new(substitute(b, name, value))),
        Forall(n, t, b) => Forall(n.clone(), t.clone(), Box::new(substitute(b, name, value))),
        Exists(n, t, b) => Exists(n.clone(), t.clone(), Box::new(substitute(b, name, value))),
        App(a, b) => App(
            Box::new(substitute(a, name, value)),
            Box::new(substitute(b, name, value)),
        ),
        Imp(a, b) => Imp(
            Box::new(substitute(a, name, value)),
            Box::new(substitute(b, name, value)),
        ),
        And(a, b) => And(
            Box::new(substitute(a, name, value)),
            Box::new(substitute(b, name, value)),
        ),
        Equal(a, b) => Equal(
            Box::new(substitute(a, name, value)),
            Box::new(substitute(b, name, value)),
        ),
    }
}

fn alpha(a: &Expr, b: &Expr, left: &mut Vec<String>, right: &mut Vec<String>) -> bool {
    use Expr::*;
    match (a, b) {
        (Var(x, xt), Var(y, yt)) if xt == yt => {
            let ix = left.iter().rposition(|n| n == x);
            let iy = right.iter().rposition(|n| n == y);
            match (ix, iy) {
                (Some(i), Some(j)) => left.len() - i == right.len() - j,
                (None, None) => x == y,
                _ => false,
            }
        }
        (Const(x, xt), Const(y, yt)) => x == y && xt == yt,
        (False, False) => true,
        (Lam(x, xt, xb), Lam(y, yt, yb))
        | (Forall(x, xt, xb), Forall(y, yt, yb))
        | (Exists(x, xt, xb), Exists(y, yt, yb))
            if xt == yt =>
        {
            left.push(x.clone());
            right.push(y.clone());
            let result = alpha(xb, yb, left, right);
            left.pop();
            right.pop();
            result
        }
        (App(xa, xb), App(ya, yb))
        | (Imp(xa, xb), Imp(ya, yb))
        | (And(xa, xb), And(ya, yb))
        | (Equal(xa, xb), Equal(ya, yb)) => {
            alpha(xa, ya, left, right) && alpha(xb, yb, left, right)
        }
        _ => false,
    }
}
fn alpha_equal(a: &Expr, b: &Expr) -> bool {
    alpha(a, b, &mut Vec::new(), &mut Vec::new())
}

struct State {
    remaining: usize,
    reductions: usize,
}
impl State {
    fn spend(&mut self) -> Result<(), String> {
        self.remaining = self
            .remaining
            .checked_sub(1)
            .ok_or("HOL verification node limit exhausted")?;
        Ok(())
    }
    fn reduction(&mut self) -> Result<(), String> {
        self.reductions = self
            .reductions
            .checked_sub(1)
            .ok_or("HOL beta reduction limit exhausted")?;
        Ok(())
    }
}

fn ty_of(e: &Expr, env: &[(String, Ty)], state: &mut State) -> Result<Ty, String> {
    state.spend()?;
    use Expr::*;
    match e {
        Var(name, ty) => {
            if env.iter().rev().any(|(n, t)| n == name && t == ty) {
                Ok(ty.clone())
            } else {
                Err(format!(
                    "HOL variable {name} is unbound or has the wrong type"
                ))
            }
        }
        Const(name, ty) if !name.trim().is_empty() && valid_type(ty, 0) => Ok(ty.clone()),
        Const(..) => Err("HOL constant has an invalid name or type".into()),
        False => Ok(Ty::Prop),
        Lam(n, t, b) => {
            if n.trim().is_empty() || !valid_type(t, 0) || env.iter().any(|(name, _)| name == n) {
                return Err("HOL invalid or shadowed lambda binder".into());
            }
            let mut child = env.to_vec();
            child.push((n.clone(), t.clone()));
            Ok(Ty::Arrow(
                Box::new(t.clone()),
                Box::new(ty_of(b, &child, state)?),
            ))
        }
        App(f, x) => match ty_of(f, env, state)? {
            Ty::Arrow(arg, res) if *arg == ty_of(x, env, state)? => Ok(*res),
            _ => Err("HOL function application has incompatible types".into()),
        },
        Imp(a, b) | And(a, b) => {
            if ty_of(a, env, state)? != Ty::Prop || ty_of(b, env, state)? != Ty::Prop {
                return Err("HOL connective requires propositions".into());
            }
            Ok(Ty::Prop)
        }
        Forall(n, t, b) | Exists(n, t, b) => {
            if n.trim().is_empty() || !valid_type(t, 0) || env.iter().any(|(name, _)| name == n) {
                return Err("HOL invalid or shadowed quantifier binder".into());
            }
            let mut child = env.to_vec();
            child.push((n.clone(), t.clone()));
            if ty_of(b, &child, state)? != Ty::Prop {
                return Err("HOL quantifier body must be a proposition".into());
            }
            Ok(Ty::Prop)
        }
        Equal(a, b) => {
            let at = ty_of(a, env, state)?;
            if at != ty_of(b, env, state)? {
                return Err("HOL equality requires identical types".into());
            }
            Ok(Ty::Prop)
        }
    }
}

fn normalize(e: &Expr, state: &mut State) -> Result<Expr, String> {
    state.spend()?;
    use Expr::*;
    match e {
        App(a, b) => {
            let f = normalize(a, state)?;
            let x = normalize(b, state)?;
            if let Lam(n, _, body) = f {
                state.reduction()?;
                normalize(&substitute(&body, &n, &x), state)
            } else {
                Ok(App(Box::new(f), Box::new(x)))
            }
        }
        Lam(n, t, b) => Ok(Lam(n.clone(), t.clone(), Box::new(normalize(b, state)?))),
        Forall(n, t, b) => Ok(Forall(n.clone(), t.clone(), Box::new(normalize(b, state)?))),
        Exists(n, t, b) => Ok(Exists(n.clone(), t.clone(), Box::new(normalize(b, state)?))),
        Imp(a, b) => Ok(Imp(
            Box::new(normalize(a, state)?),
            Box::new(normalize(b, state)?),
        )),
        And(a, b) => Ok(And(
            Box::new(normalize(a, state)?),
            Box::new(normalize(b, state)?),
        )),
        Equal(a, b) => Ok(Equal(
            Box::new(normalize(a, state)?),
            Box::new(normalize(b, state)?),
        )),
        Var(..) | Const(..) | False => Ok(e.clone()),
    }
}
fn same(a: &Expr, b: &Expr, state: &mut State) -> Result<bool, String> {
    let x = normalize(a, state)?;
    let y = normalize(b, state)?;
    Ok(alpha_equal(&x, &y))
}

fn prove(
    d: &Derivation,
    env: &[(String, Ty)],
    assumptions: &[Expr],
    state: &mut State,
) -> Result<Expr, String> {
    state.spend()?;
    use Derivation::*;
    let result = match d {
        Hypothesis(i) => assumptions
            .get(*i)
            .cloned()
            .ok_or("HOL hypothesis index is invalid")?,
        ImpIntro { assumption, body } => {
            let mut ctx = assumptions.to_vec();
            ctx.push(assumption.clone());
            Expr::Imp(
                Box::new(assumption.clone()),
                Box::new(prove(body, env, &ctx, state)?),
            )
        }
        ImpElim(a, b) => {
            let antecedent = prove(b, env, assumptions, state)?;
            match normalize(&prove(a, env, assumptions, state)?, state)? {
                Expr::Imp(p, q) if same(&p, &antecedent, state)? => *q,
                _ => return Err("HOL implication elimination requires matching antecedent".into()),
            }
        }
        AndIntro(a, b) => Expr::And(
            Box::new(prove(a, env, assumptions, state)?),
            Box::new(prove(b, env, assumptions, state)?),
        ),
        AndLeft(a) => match normalize(&prove(a, env, assumptions, state)?, state)? {
            Expr::And(p, _) => *p,
            _ => return Err("HOL left conjunction elimination needs conjunction".into()),
        },
        AndRight(a) => match normalize(&prove(a, env, assumptions, state)?, state)? {
            Expr::And(_, q) => *q,
            _ => return Err("HOL right conjunction elimination needs conjunction".into()),
        },
        ForallIntro { variable, ty, body } => {
            if variable.trim().is_empty()
                || !valid_type(ty, 0)
                || env.iter().any(|(n, _)| n == variable)
                || assumptions.iter().any(|a| free(variable, a))
            {
                return Err("HOL forall introduction violates eigenvariable condition".into());
            }
            let mut child = env.to_vec();
            child.push((variable.clone(), ty.clone()));
            let p = prove(body, &child, assumptions, state)?;
            Expr::Forall(variable.clone(), ty.clone(), Box::new(p))
        }
        ForallElim { universal, witness } => {
            match normalize(&prove(universal, env, assumptions, state)?, state)? {
                Expr::Forall(n, ty, p) if ty_of(witness, env, state)? == ty => {
                    substitute(&p, &n, witness)
                }
                _ => {
                    return Err(
                        "HOL forall elimination requires a witness of the bound type".into(),
                    )
                }
            }
        }
        FalseElim {
            contradiction,
            conclusion,
        } => {
            if !same(
                &prove(contradiction, env, assumptions, state)?,
                &Expr::False,
                state,
            )? {
                return Err("HOL false elimination requires a proof of false".into());
            }
            if ty_of(conclusion, env, state)? != Ty::Prop {
                return Err("HOL false elimination conclusion must be a proposition".into());
            }
            conclusion.clone()
        }
        ExistsIntro {
            variable,
            ty,
            body,
            witness,
            proof,
        } => {
            if variable.trim().is_empty()
                || !valid_type(ty, 0)
                || env.iter().any(|(n, _)| n == variable)
            {
                return Err("HOL invalid existential binder".into());
            }
            if ty_of(witness, env, state)? != *ty {
                return Err("HOL existential witness has the wrong type".into());
            }
            let mut extended = env.to_vec();
            extended.push((variable.clone(), ty.clone()));
            if ty_of(body, &extended, state)? != Ty::Prop {
                return Err("HOL existential body must be a proposition".into());
            }
            let instantiated = substitute(body, variable, witness);
            if !same(
                &prove(proof, env, assumptions, state)?,
                &instantiated,
                state,
            )? {
                return Err("HOL existential introduction requires a proved witness".into());
            }
            Expr::Exists(variable.clone(), ty.clone(), Box::new(body.clone()))
        }
        ExistsElim {
            existential,
            eigenvariable,
            body,
        } => {
            let premise = normalize(&prove(existential, env, assumptions, state)?, state)?;
            let Expr::Exists(variable, ty, predicate) = premise else {
                return Err("HOL existential elimination requires a proved existential".into());
            };
            if eigenvariable.trim().is_empty()
                || env.iter().any(|(n, _)| n == eigenvariable)
                || assumptions.iter().any(|a| free(eigenvariable, a))
                || free(eigenvariable, &predicate)
            {
                return Err("HOL existential elimination eigenvariable is not fresh".into());
            }
            let witness = Expr::Var(eigenvariable.clone(), ty.clone());
            let instantiated = substitute(&predicate, &variable, &witness);
            let mut extended = env.to_vec();
            extended.push((eigenvariable.clone(), ty));
            let mut hypotheses = assumptions.to_vec();
            hypotheses.push(instantiated);
            let conclusion = prove(body, &extended, &hypotheses, state)?;
            if free(eigenvariable, &conclusion) {
                return Err("HOL existential witness escaped its scope".into());
            }
            conclusion
        }
        FunctionExtensionality {
            left,
            right,
            pointwise,
        } => {
            let left_ty = ty_of(left, env, state)?;
            let Ty::Arrow(arg, _) = left_ty.clone() else {
                return Err("HOL function extensionality requires a function".into());
            };
            if ty_of(right, env, state)? != left_ty {
                return Err("HOL extensionality functions must have identical types".into());
            }
            let variable = fresh(left, right);
            let x = Expr::Var(variable.clone(), *arg.clone());
            let expected = Expr::Forall(
                variable,
                *arg,
                Box::new(Expr::Equal(
                    Box::new(Expr::App(Box::new(left.clone()), Box::new(x.clone()))),
                    Box::new(Expr::App(Box::new(right.clone()), Box::new(x))),
                )),
            );
            if !same(
                &prove(pointwise, env, assumptions, state)?,
                &expected,
                state,
            )? {
                return Err("HOL function extensionality requires a pointwise proof".into());
            }
            Expr::Equal(Box::new(left.clone()), Box::new(right.clone()))
        }
        PropositionExtensionality {
            left,
            right,
            forward,
            reverse,
        } => {
            if ty_of(left, env, state)? != Ty::Prop || ty_of(right, env, state)? != Ty::Prop {
                return Err("HOL proposition extensionality expects propositions".into());
            }
            let fw = Expr::Imp(Box::new(left.clone()), Box::new(right.clone()));
            let rv = Expr::Imp(Box::new(right.clone()), Box::new(left.clone()));
            if !same(&prove(forward, env, assumptions, state)?, &fw, state)?
                || !same(&prove(reverse, env, assumptions, state)?, &rv, state)?
            {
                return Err("HOL proposition extensionality requires both implications".into());
            }
            Expr::Equal(Box::new(left.clone()), Box::new(right.clone()))
        }
        EqualRefl(term) => Expr::Equal(Box::new(term.clone()), Box::new(term.clone())),
        EqualElim {
            equality,
            predicate,
            proof,
        } => {
            let eq = normalize(&prove(equality, env, assumptions, state)?, state)?;
            let Expr::Equal(a, b) = eq else {
                return Err("HOL equality elimination requires an equation".into());
            };
            let predicate_ty = ty_of(predicate, env, state)?;
            let Ty::Arrow(arg, result) = predicate_ty else {
                return Err("HOL substitution expects a unary predicate".into());
            };
            if *result != Ty::Prop || ty_of(&a, env, state)? != *arg {
                return Err("HOL equality predicate has incompatible type".into());
            }
            let premise = prove(proof, env, assumptions, state)?;
            if !same(&premise, &Expr::App(Box::new(predicate.clone()), a), state)? {
                return Err("HOL equality substitution premise does not match".into());
            }
            Expr::App(Box::new(predicate.clone()), b)
        }
        Classical {
            proposition,
            double_negation,
        } => {
            if ty_of(proposition, env, state)? != Ty::Prop {
                return Err("HOL classical elimination expects a proposition".into());
            }
            let neg = Expr::Imp(Box::new(proposition.clone()), Box::new(Expr::False));
            let expected = Expr::Imp(Box::new(neg), Box::new(Expr::False));
            if !same(
                &prove(double_negation, env, assumptions, state)?,
                &expected,
                state,
            )? {
                return Err("HOL classical elimination requires a checked double negation".into());
            }
            proposition.clone()
        }
    };
    if ty_of(&result, env, state)? != Ty::Prop {
        return Err("HOL proof produced a non-proposition".into());
    }
    Ok(result)
}

/// Check a deduction using only explicitly supplied hypotheses. An empty
/// hypothesis set proves a closed theorem. Failure or exhaustion never proves
/// falsity; a conclusion cannot be accepted without a full derivation tree.
pub fn verify(
    goal: &Expr,
    hypotheses: &[Expr],
    derivation: &Derivation,
    budget: Budget,
) -> Result<(), String> {
    if budget.max_nodes == 0 || budget.max_reductions == 0 {
        return Err("HOL budgets must be positive".into());
    }
    let mut state = State {
        remaining: budget.max_nodes,
        reductions: budget.max_reductions,
    };
    for p in hypotheses {
        if ty_of(p, &[], &mut state)? != Ty::Prop {
            return Err("HOL hypothesis is not a closed proposition".into());
        }
    }
    if ty_of(goal, &[], &mut state)? != Ty::Prop {
        return Err("HOL goal is not a closed proposition".into());
    }
    let result = prove(derivation, &[], hypotheses, &mut state)?;
    if same(&result, goal, &mut state)? {
        Ok(())
    } else {
        Err("HOL derived conclusion differs from requested goal".into())
    }
}
