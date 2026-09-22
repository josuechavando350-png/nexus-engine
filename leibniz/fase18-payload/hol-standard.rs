//! Higher-order regression cases: quantification is over arbitrary functions,
//! not over the finite predicate catalog of the separate Horn reasoner.
use nexus_leibniz::hol::{verify, Budget, Derivation as D, Expr as E, Ty};

fn individual() -> Ty { Ty::Individual }
fn proposition() -> Ty { Ty::Prop }
fn arrow(a: Ty, b: Ty) -> Ty { Ty::Arrow(Box::new(a), Box::new(b)) }
fn variable(name: &str, ty: Ty) -> E { E::Var(name.to_owned(), ty) }
fn app(f: E, x: E) -> E { E::App(Box::new(f), Box::new(x)) }
fn implication(a: E, b: E) -> E { E::Imp(Box::new(a), Box::new(b)) }
fn universal(name: &str, ty: Ty, body: E) -> E {
    E::Forall(name.to_owned(), ty, Box::new(body))
}
fn introduction(name: &str, ty: Ty, body: D) -> D {
    D::ForallIntro { variable: name.to_owned(), ty, body: Box::new(body) }
}
fn prove_closed(goal: &E, proof: &D) {
    verify(goal, &[], proof, Budget::default()).unwrap();
}

#[test]
fn arbitrary_predicate_is_applied_inside_a_closed_universal_theorem() {
    let predicate_ty = arrow(individual(), proposition());
    let px = app(variable("P", predicate_ty.clone()), variable("x", individual()));
    let goal = universal("P", predicate_ty.clone(), universal("x", individual(),
        implication(px.clone(), px.clone())));
    let proof = introduction("P", predicate_ty, introduction("x", individual(),
        D::ImpIntro { assumption: px, body: Box::new(D::Hypothesis(0)) }));
    prove_closed(&goal, &proof);
}

#[test]
fn predicates_of_predicates_are_applied_not_merely_named() {
    let predicate_ty = arrow(individual(), proposition());
    let functional_ty = arrow(predicate_ty.clone(), proposition());
    let fp = app(variable("F", functional_ty.clone()), variable("P", predicate_ty.clone()));
    let goal = universal("F", functional_ty.clone(), universal("P", predicate_ty.clone(),
        implication(fp.clone(), fp.clone())));
    let proof = introduction("F", functional_ty, introduction("P", predicate_ty,
        D::ImpIntro { assumption: fp, body: Box::new(D::Hypothesis(0)) }));
    prove_closed(&goal, &proof);
}

#[test]
fn universal_elimination_instantiates_a_new_lambda_not_in_any_catalog() {
    let predicate_ty = arrow(individual(), proposition());
    let at = E::Const("a".to_owned(), individual());
    let pa = app(variable("P", predicate_ty.clone()), at.clone());
    let universal_goal = universal("P", predicate_ty.clone(), implication(pa.clone(), pa.clone()));
    let universal_proof = introduction("P", predicate_ty, D::ImpIntro {
        assumption: pa, body: Box::new(D::Hypothesis(0)),
    });
    prove_closed(&universal_goal, &universal_proof);
    let witness = E::Lam("x".to_owned(), individual(), Box::new(E::False));
    let instance = app(witness.clone(), at);
    let goal = implication(instance.clone(), instance);
    prove_closed(&goal, &D::ForallElim { universal: Box::new(universal_proof), witness });
}

#[test]
fn forged_arbitrary_predicate_assertion_is_not_a_theorem() {
    let predicate_ty = arrow(individual(), proposition());
    let goal = universal("P", predicate_ty.clone(), app(variable("P", predicate_ty.clone()),
        E::Const("a".to_owned(), individual())));
    let forged = introduction("P", predicate_ty, D::Hypothesis(0));
    assert!(verify(&goal, &[], &forged, Budget::default()).is_err());
}

#[test]
fn predicate_extensionality_requires_a_checked_pointwise_premise() {
    let predicate_ty = arrow(individual(), proposition());
    let left = variable("P", predicate_ty.clone());
    let right = variable("Q", predicate_ty.clone());
    let x = variable("x", individual());
    let pointwise = universal("x", individual(), E::Equal(
        Box::new(app(left.clone(), x.clone())), Box::new(app(right.clone(), x))));
    let conclusion = E::Equal(Box::new(left.clone()), Box::new(right.clone()));
    let goal = universal("P", predicate_ty.clone(), universal("Q", predicate_ty.clone(),
        implication(pointwise.clone(), conclusion)));
    let proof = introduction("P", predicate_ty.clone(), introduction("Q", predicate_ty,
        D::ImpIntro { assumption: pointwise, body: Box::new(D::FunctionExtensionality {
            left, right, pointwise: Box::new(D::Hypothesis(0)),
        }) }));
    prove_closed(&goal, &proof);
}
