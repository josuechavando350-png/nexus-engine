//! Independent exhaustive standard-model checks of higher-order certificates.
//! A successful bounded model check is not a general completeness theorem.
use nexus_leibniz::finite_model::{FiniteModel, Value};
use nexus_leibniz::hol::{verify, Budget, Derivation as D, Expr as E, Ty};

fn ind() -> Ty {
    Ty::Individual
}
fn prop() -> Ty {
    Ty::Prop
}
fn arrow(a: Ty, b: Ty) -> Ty {
    Ty::Arrow(Box::new(a), Box::new(b))
}
fn var(name: &str, ty: Ty) -> E {
    E::Var(name.into(), ty)
}
fn app(f: E, x: E) -> E {
    E::App(Box::new(f), Box::new(x))
}
fn imp(a: E, b: E) -> E {
    E::Imp(Box::new(a), Box::new(b))
}
fn all(name: &str, ty: Ty, body: E) -> E {
    E::Forall(name.into(), ty, Box::new(body))
}
fn exists(name: &str, ty: Ty, body: E) -> E {
    E::Exists(name.into(), ty, Box::new(body))
}
fn eq(a: E, b: E) -> E {
    E::Equal(Box::new(a), Box::new(b))
}
fn intro(name: &str, ty: Ty, proof: D) -> D {
    D::ForallIntro {
        variable: name.into(),
        ty,
        body: Box::new(proof),
    }
}
fn models_hold(goal: &E, proof: &D) {
    verify(goal, &[], proof, Budget::default()).unwrap();
    for n in 1..=2 {
        let model = FiniteModel::new(n, 256, 1_000_000).unwrap();
        assert!(
            model.evaluate(goal).unwrap(),
            "countermodel at {n} individuals: {goal:?}"
        );
    }
}

#[test]
fn independent_oracle_proves_predicate_identity_in_full_function_domains() {
    let pt = arrow(ind(), prop());
    let atom = app(var("P", pt.clone()), var("x", ind()));
    let goal = all(
        "P",
        pt.clone(),
        all("x", ind(), imp(atom.clone(), atom.clone())),
    );
    let proof = intro(
        "P",
        pt,
        intro(
            "x",
            ind(),
            D::ImpIntro {
                assumption: atom,
                body: Box::new(D::Hypothesis(0)),
            },
        ),
    );
    models_hold(&goal, &proof);
}

#[test]
fn independent_oracle_quantifies_over_every_predicate_of_predicates() {
    let pt = arrow(ind(), prop());
    let ft = arrow(pt.clone(), prop());
    let atom = app(var("F", ft.clone()), var("P", pt.clone()));
    let goal = all(
        "F",
        ft.clone(),
        all("P", pt.clone(), imp(atom.clone(), atom.clone())),
    );
    let proof = intro(
        "F",
        ft,
        intro(
            "P",
            pt,
            D::ImpIntro {
                assumption: atom,
                body: Box::new(D::Hypothesis(0)),
            },
        ),
    );
    models_hold(&goal, &proof);
}

#[test]
fn independent_oracle_checks_lambda_application_and_extensional_equality() {
    let pt = arrow(ind(), prop());
    let p = var("P", pt.clone());
    let x = var("x", ind());
    let beta = app(
        E::Lam("z".into(), ind(), Box::new(app(p.clone(), var("z", ind())))),
        x.clone(),
    );
    let goal = all(
        "P",
        pt.clone(),
        all("x", ind(), eq(beta.clone(), app(p, x))),
    );
    let proof = intro("P", pt, intro("x", ind(), D::EqualRefl(beta)));
    models_hold(&goal, &proof);
}

#[test]
fn independent_oracle_checks_function_extensionality() {
    let pt = arrow(ind(), prop());
    let p = var("P", pt.clone());
    let q = var("Q", pt.clone());
    let x = var("x", ind());
    let pointwise = all("x", ind(), eq(app(p.clone(), x.clone()), app(q.clone(), x)));
    let goal = all(
        "P",
        pt.clone(),
        all(
            "Q",
            pt.clone(),
            imp(pointwise.clone(), eq(p.clone(), q.clone())),
        ),
    );
    let proof = intro(
        "P",
        pt.clone(),
        intro(
            "Q",
            pt,
            D::ImpIntro {
                assumption: pointwise,
                body: Box::new(D::FunctionExtensionality {
                    left: p,
                    right: q,
                    pointwise: Box::new(D::Hypothesis(0)),
                }),
            },
        ),
    );
    models_hold(&goal, &proof);
}

#[test]
fn full_domains_contain_every_function_not_just_named_predicates() {
    let model = FiniteModel::new(2, 256, 1_000_000).unwrap();
    let predicates = model.domain(&arrow(ind(), prop())).unwrap();
    assert_eq!(predicates.len(), 4);
    let functionals = model.domain(&arrow(arrow(ind(), prop()), prop())).unwrap();
    assert_eq!(functionals.len(), 16);
    assert!(predicates.contains(&Value::Function(vec![
        Value::Truth(false),
        Value::Truth(true)
    ])));
}

#[test]
fn independently_finds_countermodel_to_forged_universal_assertion() {
    let pt = arrow(ind(), prop());
    let goal = all(
        "P",
        pt.clone(),
        all("x", ind(), app(var("P", pt.clone()), var("x", ind()))),
    );
    assert!(!FiniteModel::new(1, 256, 1_000_000)
        .unwrap()
        .evaluate(&goal)
        .unwrap());
    assert!(verify(&goal, &[], &D::Hypothesis(0), Budget::default()).is_err());
}

#[test]
fn finite_validity_is_not_mistaken_for_a_supplied_proof() {
    let pt = arrow(ind(), prop());
    let exists_true_predicate = exists(
        "P",
        pt.clone(),
        all("x", ind(), app(var("P", pt), var("x", ind()))),
    );
    for n in 1..=2 {
        assert!(FiniteModel::new(n, 256, 1_000_000)
            .unwrap()
            .evaluate(&exists_true_predicate)
            .unwrap());
    }
    assert!(verify(
        &exists_true_predicate,
        &[],
        &D::Hypothesis(0),
        Budget::default()
    )
    .is_err());
}

#[test]
fn independent_truth_table_checks_classical_double_negation() {
    let formula = E::Const("q".into(), prop());
    let not = imp(formula.clone(), E::False);
    let nn = imp(not, E::False);
    let theorem = imp(nn.clone(), formula.clone());
    let proof = D::ImpIntro {
        assumption: nn,
        body: Box::new(D::Classical {
            proposition: formula.clone(),
            double_negation: Box::new(D::Hypothesis(0)),
        }),
    };
    verify(&theorem, &[], &proof, Budget::default()).unwrap();
    for truth in [false, true] {
        let mut model = FiniteModel::new(1, 256, 1_000_000).unwrap();
        model
            .set_constant("q", prop(), Value::Truth(truth))
            .unwrap();
        assert!(model.evaluate(&theorem).unwrap());
    }
}

#[test]
fn independent_oracle_separates_models_of_distinct_cardinality() {
    let x = var("x", ind());
    let y = var("y", ind());
    let formula = all("x", ind(), all("y", ind(), eq(x, y)));
    assert!(FiniteModel::new(1, 256, 1_000_000)
        .unwrap()
        .evaluate(&formula)
        .unwrap());
    assert!(!FiniteModel::new(2, 256, 1_000_000)
        .unwrap()
        .evaluate(&formula)
        .unwrap());
}

#[test]
fn malformed_or_missing_constants_and_ill_typed_formulas_fail_closed() {
    let mut model = FiniteModel::new(2, 256, 1_000_000).unwrap();
    assert!(model
        .set_constant(
            "f",
            arrow(ind(), prop()),
            Value::Function(vec![Value::Truth(true)])
        )
        .is_err());
    let invalid = app(E::Const("f".into(), ind()), E::Const("a".into(), ind()));
    assert!(model.evaluate(&invalid).is_err());
    let missing = E::Const("unknown".into(), prop());
    assert!(model.evaluate(&missing).is_err());
}

#[test]
fn model_limits_fail_closed_before_exponential_enumeration() {
    let model = FiniteModel::new(2, 15, 1_000_000).unwrap();
    assert!(model.domain(&arrow(arrow(ind(), prop()), prop())).is_err());
    let tight = FiniteModel::new(1, 256, 1).unwrap();
    assert!(tight.evaluate(&E::False).is_err());
    assert!(FiniteModel::new(0, 256, 1_000_000).is_err());
    assert!(FiniteModel::new(2, 1, 1_000_000).is_err());
}
