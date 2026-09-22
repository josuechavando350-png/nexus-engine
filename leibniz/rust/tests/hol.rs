use nexus_leibniz::hol::{verify, Budget, Derivation as D, Expr as E, Ty};
fn i() -> Ty {
    Ty::Individual
}
fn p() -> Ty {
    Ty::Prop
}
fn arrow(a: Ty, b: Ty) -> Ty {
    Ty::Arrow(Box::new(a), Box::new(b))
}
fn v(s: &str, t: Ty) -> E {
    E::Var(s.into(), t)
}
fn c(s: &str, t: Ty) -> E {
    E::Const(s.into(), t)
}
fn app(f: E, x: E) -> E {
    E::App(Box::new(f), Box::new(x))
}
fn imp(a: E, b: E) -> E {
    E::Imp(Box::new(a), Box::new(b))
}
fn forall(s: &str, t: Ty, b: E) -> E {
    E::Forall(s.into(), t, Box::new(b))
}
fn lam(s: &str, t: Ty, b: E) -> E {
    E::Lam(s.into(), t, Box::new(b))
}
fn and(a: E, b: E) -> E {
    E::And(Box::new(a), Box::new(b))
}
fn check(g: &E, d: &D) -> Result<(), String> {
    verify(g, &[], d, Budget::default())
}

fn identity_theorem(t: Ty) -> (E, D) {
    let variable = v("x", t.clone());
    let goal = forall(
        "x",
        t.clone(),
        imp(
            E::Equal(Box::new(variable.clone()), Box::new(variable.clone())),
            E::Equal(Box::new(variable.clone()), Box::new(variable)),
        ),
    );
    let deriv = D::ForallIntro {
        variable: "x".into(),
        ty: t,
        body: Box::new(D::ImpIntro {
            assumption: match &goal {
                E::Forall(_, _, b) => match &**b {
                    E::Imp(a, _) => *a.clone(),
                    _ => unreachable!(),
                },
                _ => unreachable!(),
            },
            body: Box::new(D::Hypothesis(0)),
        }),
    };
    (goal, deriv)
}

#[test]
fn quantifies_over_all_individuals_not_a_finite_catalog() {
    let (g, d) = identity_theorem(i());
    check(&g, &d).unwrap();
}
#[test]
fn quantifies_over_arbitrary_predicates_not_just_registered_symbols() {
    let (g, d) = identity_theorem(arrow(i(), p()));
    check(&g, &d).unwrap();
}
#[test]
fn quantifies_over_predicates_of_predicates() {
    let (g, d) = identity_theorem(arrow(arrow(i(), p()), p()));
    check(&g, &d).unwrap();
}
#[test]
fn quantifies_over_arbitrarily_nested_simple_types() {
    let mut t = i();
    for _ in 0..12 {
        t = arrow(t, p());
    }
    let (g, d) = identity_theorem(t);
    check(&g, &d).unwrap();
}
#[test]
fn universal_identity_computes_real_beta_reduction() {
    let pt = arrow(i(), p());
    let x = v("x", i());
    let applied = app(
        lam("z", i(), app(v("P", pt.clone()), v("z", i()))),
        x.clone(),
    );
    let a = app(v("P", pt.clone()), x);
    let goal = forall("P", pt.clone(), forall("x", i(), imp(a.clone(), applied)));
    let deriv = D::ForallIntro {
        variable: "P".into(),
        ty: pt,
        body: Box::new(D::ForallIntro {
            variable: "x".into(),
            ty: i(),
            body: Box::new(D::ImpIntro {
                assumption: a,
                body: Box::new(D::Hypothesis(0)),
            }),
        }),
    };
    check(&goal, &deriv).unwrap();
}
#[test]
fn forall_elimination_accepts_a_higher_order_witness() {
    let pt = arrow(i(), p());
    let x = v("x", i());
    let premise = forall(
        "P",
        pt.clone(),
        imp(
            app(v("P", pt.clone()), x.clone()),
            app(v("P", pt.clone()), x.clone()),
        ),
    );
    let witness = lam("z", i(), app(c("alive", pt.clone()), v("z", i())));
    let instantiated = imp(app(witness.clone(), x.clone()), app(witness.clone(), x));
    let theorem = forall("x", i(), imp(premise.clone(), instantiated));
    // The witness is an arbitrary well-typed lambda, not a catalog element.
    let d = D::ForallIntro {
        variable: "x".into(),
        ty: i(),
        body: Box::new(D::ImpIntro {
            assumption: premise,
            body: Box::new(D::ForallElim {
                universal: Box::new(D::Hypothesis(0)),
                witness,
            }),
        }),
    };
    check(&theorem, &d).unwrap();
}
#[test]
fn rejects_quantifier_witness_with_wrong_type() {
    let pt = arrow(i(), p());
    let goal = imp(forall("P", pt, E::False), E::False);
    let d = D::ImpIntro {
        assumption: match &goal {
            E::Imp(a, _) => *a.clone(),
            _ => unreachable!(),
        },
        body: Box::new(D::ForallElim {
            universal: Box::new(D::Hypothesis(0)),
            witness: c("thing", i()),
        }),
    };
    assert!(check(&goal, &d).is_err());
}
#[test]
fn rejects_freshness_violation_from_open_assumption() {
    let x = v("x", i());
    let a = app(c("property", arrow(i(), p())), x);
    let goal = forall("x", i(), imp(a.clone(), a.clone()));
    let d = D::ImpIntro {
        assumption: a.clone(),
        body: Box::new(D::ForallIntro {
            variable: "x".into(),
            ty: i(),
            body: Box::new(D::Hypothesis(0)),
        }),
    };
    assert!(check(&imp(a, goal), &d).is_err());
}
#[test]
fn refuses_to_accept_a_hypothesis_as_a_closed_theorem() {
    let atom = c("claim", p());
    assert!(check(&atom, &D::Hypothesis(0)).is_err());
}
#[test]
fn false_is_not_a_provable_closed_theorem_by_reflexivity() {
    assert!(check(&E::False, &D::EqualRefl(c("a", i()))).is_err());
}
#[test]
fn classical_double_negation_is_checked_not_asserted() {
    let q = c("q", p());
    let neg = imp(q.clone(), E::False);
    let nn = imp(neg, E::False);
    let theorem = imp(nn.clone(), q.clone());
    let d = D::ImpIntro {
        assumption: nn,
        body: Box::new(D::Classical {
            proposition: q,
            double_negation: Box::new(D::Hypothesis(0)),
        }),
    };
    check(&theorem, &d).unwrap();
}
#[test]
fn rejects_forged_classical_proof() {
    let q = c("q", p());
    let d = D::Classical {
        proposition: q.clone(),
        double_negation: Box::new(D::EqualRefl(q.clone())),
    };
    assert!(check(&q, &d).is_err());
}
#[test]
fn equality_substitution_requires_true_predicate_premise() {
    let pred = lam("z", i(), app(c("good", arrow(i(), p())), v("z", i())));
    let a = c("a", i());
    let b = c("b", i());
    let equal = E::Equal(Box::new(a.clone()), Box::new(b.clone()));
    let pa = app(pred.clone(), a);
    let pb = app(pred.clone(), b);
    let goal = imp(equal.clone(), imp(pa.clone(), pb));
    let d = D::ImpIntro {
        assumption: equal,
        body: Box::new(D::ImpIntro {
            assumption: pa,
            body: Box::new(D::EqualElim {
                equality: Box::new(D::Hypothesis(0)),
                predicate: pred,
                proof: Box::new(D::Hypothesis(1)),
            }),
        }),
    };
    check(&goal, &d).unwrap();
}
#[test]
fn equality_substitution_rejects_mismatched_premise() {
    let pred = lam("z", i(), app(c("good", arrow(i(), p())), v("z", i())));
    let a = c("a", i());
    let b = c("b", i());
    let equal = E::Equal(Box::new(a.clone()), Box::new(b.clone()));
    let pa = app(pred.clone(), a);
    let pb = app(pred.clone(), b);
    let goal = imp(equal.clone(), imp(pa.clone(), pb));
    let d = D::ImpIntro {
        assumption: equal,
        body: Box::new(D::ImpIntro {
            assumption: pa,
            body: Box::new(D::EqualElim {
                equality: Box::new(D::Hypothesis(0)),
                predicate: pred,
                proof: Box::new(D::Hypothesis(0)),
            }),
        }),
    };
    assert!(check(&goal, &d).is_err());
}
#[test]
fn rejects_ill_typed_formula_even_when_proof_is_self_reference() {
    let formula = app(c("not_a_function", i()), c("x", i()));
    let d = D::ImpIntro {
        assumption: formula.clone(),
        body: Box::new(D::Hypothesis(0)),
    };
    assert!(check(&imp(formula.clone(), formula), &d).is_err());
}
#[test]
fn rejects_shadowed_binders_to_avoid_variable_capture() {
    let goal = forall("x", i(), forall("x", i(), imp(E::False, E::False)));
    let d = D::ForallIntro {
        variable: "x".into(),
        ty: i(),
        body: Box::new(D::ForallIntro {
            variable: "x".into(),
            ty: i(),
            body: Box::new(D::ImpIntro {
                assumption: E::False,
                body: Box::new(D::Hypothesis(0)),
            }),
        }),
    };
    assert!(check(&goal, &d).is_err());
}
#[test]
fn resource_exhaustion_rejects_even_a_valid_proof() {
    let (g, d) = identity_theorem(i());
    assert!(verify(
        &g,
        &[],
        &d,
        Budget {
            max_nodes: 1,
            max_reductions: 1
        }
    )
    .is_err());
}
#[test]
fn source_free_proof_cannot_derive_a_specific_external_claim() {
    let market = c("market_will_rise", p());
    let (g, d) = identity_theorem(i());
    assert!(check(&market, &d).is_err());
    check(&g, &d).unwrap();
}
#[test]
fn conjunction_rules_reject_wrong_shape_and_accept_real_proof() {
    let a = c("a", p());
    let b = c("b", p());
    let combined = and(a.clone(), b.clone());
    let goal = imp(combined.clone(), a.clone());
    let d = D::ImpIntro {
        assumption: combined,
        body: Box::new(D::AndLeft(Box::new(D::Hypothesis(0)))),
    };
    check(&goal, &d).unwrap();
    assert!(check(&b, &D::AndRight(Box::new(D::EqualRefl(c("x", i()))))).is_err());
}

#[test]
fn existential_requires_a_real_witness_proof() {
    let pred = c("P", arrow(i(), p()));
    let a = c("a", i());
    let pa = app(pred.clone(), a.clone());
    let body = app(pred, v("x", i()));
    let goal = imp(
        pa.clone(),
        E::Exists("x".into(), i(), Box::new(body.clone())),
    );
    let proof = D::ImpIntro {
        assumption: pa,
        body: Box::new(D::ExistsIntro {
            variable: "x".into(),
            ty: i(),
            body,
            witness: a,
            proof: Box::new(D::Hypothesis(0)),
        }),
    };
    check(&goal, &proof).unwrap();
}

#[test]
fn existential_rejects_unproved_witness() {
    let pred = c("P", arrow(i(), p()));
    let a = c("a", i());
    let body = app(pred.clone(), v("x", i()));
    let goal = E::Exists("x".into(), i(), Box::new(body.clone()));
    let forged = D::ExistsIntro {
        variable: "x".into(),
        ty: i(),
        body,
        witness: a,
        proof: Box::new(D::EqualRefl(c("a", i()))),
    };
    assert!(check(&goal, &forged).is_err());
}

#[test]
fn existential_elimination_uses_fresh_eigenvariable_and_discharges_it() {
    let pred = c("P", arrow(i(), p()));
    let exists = E::Exists("x".into(), i(), Box::new(app(pred.clone(), v("x", i()))));
    let conclusion = c("Q", p());
    let theorem = imp(
        exists.clone(),
        imp(
            forall(
                "z",
                i(),
                imp(app(pred.clone(), v("z", i())), conclusion.clone()),
            ),
            conclusion.clone(),
        ),
    );
    let eigen = v("fresh", i());
    let deriv = D::ImpIntro {
        assumption: exists,
        body: Box::new(D::ImpIntro {
            assumption: forall(
                "z",
                i(),
                imp(app(pred.clone(), v("z", i())), conclusion.clone()),
            ),
            body: Box::new(D::ExistsElim {
                existential: Box::new(D::Hypothesis(0)),
                eigenvariable: "fresh".into(),
                body: Box::new(D::ImpElim(
                    Box::new(D::ForallElim {
                        universal: Box::new(D::Hypothesis(1)),
                        witness: eigen,
                    }),
                    Box::new(D::Hypothesis(2)),
                )),
            }),
        }),
    };
    check(&theorem, &deriv).unwrap();
}

#[test]
fn existential_eigenvariable_cannot_escape_as_a_conclusion() {
    let pred = c("P", arrow(i(), p()));
    let exists = E::Exists("x".into(), i(), Box::new(app(pred.clone(), v("x", i()))));
    let target = app(pred, v("escape", i()));
    let proof = D::ImpIntro {
        assumption: exists.clone(),
        body: Box::new(D::ExistsElim {
            existential: Box::new(D::Hypothesis(0)),
            eigenvariable: "escape".into(),
            body: Box::new(D::Hypothesis(1)),
        }),
    };
    assert!(check(&imp(exists, target), &proof).is_err());
}

#[test]
fn function_extensionality_accepts_proved_pointwise_equality() {
    let ft = arrow(i(), p());
    let f = c("f", ft.clone());
    let g = c("g", ft);
    let x = v("x", i());
    let pointwise = forall(
        "x",
        i(),
        E::Equal(
            Box::new(app(f.clone(), x.clone())),
            Box::new(app(g.clone(), x)),
        ),
    );
    let goal = imp(
        pointwise.clone(),
        E::Equal(Box::new(f.clone()), Box::new(g.clone())),
    );
    let proof = D::ImpIntro {
        assumption: pointwise,
        body: Box::new(D::FunctionExtensionality {
            left: f,
            right: g,
            pointwise: Box::new(D::Hypothesis(0)),
        }),
    };
    check(&goal, &proof).unwrap();
}

#[test]
fn function_extensionality_rejects_forged_pointwise_proof() {
    let ft = arrow(i(), p());
    let f = c("f", ft.clone());
    let g = c("g", ft);
    let goal = E::Equal(Box::new(f.clone()), Box::new(g.clone()));
    let proof = D::FunctionExtensionality {
        left: f,
        right: g,
        pointwise: Box::new(D::EqualRefl(c("x", i()))),
    };
    assert!(check(&goal, &proof).is_err());
}

#[test]
fn proposition_extensionality_requires_both_checked_directions() {
    let a = c("A", p());
    let b = c("B", p());
    let fw = imp(a.clone(), b.clone());
    let rv = imp(b.clone(), a.clone());
    let eq = E::Equal(Box::new(a.clone()), Box::new(b.clone()));
    let goal = imp(fw.clone(), imp(rv.clone(), eq.clone()));
    let proof = D::ImpIntro {
        assumption: fw,
        body: Box::new(D::ImpIntro {
            assumption: rv,
            body: Box::new(D::PropositionExtensionality {
                left: a.clone(),
                right: b.clone(),
                forward: Box::new(D::Hypothesis(0)),
                reverse: Box::new(D::Hypothesis(1)),
            }),
        }),
    };
    check(&goal, &proof).unwrap();
    assert!(check(
        &eq,
        &D::PropositionExtensionality {
            left: a,
            right: b,
            forward: Box::new(D::EqualRefl(c("x", i()))),
            reverse: Box::new(D::EqualRefl(c("x", i())))
        }
    )
    .is_err());
}

#[test]
fn explosion_is_only_valid_from_checked_false() {
    let p = c("claim", p());
    let goal = imp(E::False, p.clone());
    check(
        &goal,
        &D::ImpIntro {
            assumption: E::False,
            body: Box::new(D::FalseElim {
                contradiction: Box::new(D::Hypothesis(0)),
                conclusion: p.clone(),
            }),
        },
    )
    .unwrap();
    assert!(check(
        &p,
        &D::FalseElim {
            contradiction: Box::new(D::EqualRefl(c("x", i()))),
            conclusion: p.clone()
        }
    )
    .is_err());
}

#[test]
fn untrusted_higher_order_hypotheses_are_not_closed_theorems() {
    let f = c("market_proposition", p());
    let proof = D::Hypothesis(0);
    assert!(check(&f, &proof).is_err());
    verify(&f, std::slice::from_ref(&f), &proof, Budget::default()).unwrap();
}
