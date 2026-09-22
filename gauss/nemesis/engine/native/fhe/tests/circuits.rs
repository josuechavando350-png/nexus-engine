use nemesis_fhe::{Circuit,Gate,unsigned_adder,MAX_GATES};
use tfhe::boolean::gen_keys;

#[test]
fn rejects_invalid_dags() {
    for c in [
        Circuit{inputs:1,gates:vec![Gate::Not(1)],outputs:vec![1]},
        Circuit{inputs:1,gates:vec![],outputs:vec![1]},
        Circuit{inputs:0,gates:vec![],outputs:vec![0]},
        Circuit{inputs:1,gates:vec![],outputs:vec![]},
        Circuit{inputs:1,gates:vec![Gate::Not(0);MAX_GATES+1],outputs:vec![0]},
    ] { assert!(c.validate().is_err()); }
    assert!(unsigned_adder(0).is_err());
    assert!(unsigned_adder(2048).is_err());
}

#[test]
fn encrypted_gate_truth_tables_and_long_chain() {
    let (client,server)=gen_keys();
    let circuit=Circuit{inputs:3,gates:vec![Gate::Not(0),Gate::And(0,1),Gate::Or(0,1),Gate::Xor(0,1),Gate::Nand(0,1),Gate::Nor(0,1),Gate::Xnor(0,1),Gate::Mux(2,0,1)],outputs:(3..11).collect()};
    for a in [false,true] { for b in [false,true] { for s in [false,true] {
        let encrypted:Vec<_>=[a,b,s].iter().map(|&x|client.encrypt(x)).collect();
        let actual:Vec<_>=circuit.evaluate(&server,&encrypted).unwrap().iter().map(|x|client.decrypt(x)).collect();
        assert_eq!(actual,vec![!a,a&b,a|b,a^b,!(a&b),!(a|b),!(a^b),if s {a} else {b}]);
    } } }
    assert!(circuit.evaluate(&server,&[]).is_err());
    // Each NAND consumes the preceding ciphertext: no plaintext reset of noise.
    let mut gates=Vec::new();
    let mut wire=0;
    for i in 0..1024 { gates.push(Gate::Nand(wire,1)); wire=2+i; }
    let chain=Circuit{inputs:2,gates,outputs:vec![wire]};
    let result=chain.evaluate(&server,&[client.encrypt(false),client.encrypt(true)]).unwrap();
    assert!(!client.decrypt(&result[0]));
}

#[test]
fn encrypted_adder_matches_integer_arithmetic() {
    let (client,server)=gen_keys();
    for (a,b,carry) in [(0u16,0u16,false),(255,255,true),(127,1,false),(85,170,false),(42,91,true)] {
        let bits:Vec<_>=(0..8).map(|i|((a>>i)&1)==1).chain((0..8).map(|i|((b>>i)&1)==1)).chain(std::iter::once(carry)).map(|x|client.encrypt(x)).collect();
        let output=unsigned_adder(8).unwrap().evaluate(&server,&bits).unwrap();
        let sum:u16=output.iter().enumerate().map(|(i,c)|u16::from(client.decrypt(c))<<i).sum();
        assert_eq!(sum,a+b+u16::from(carry));
    }
}
