//! Motor 89: bounded Boolean circuit execution using TFHE bootstrapped gates.
//! The evaluator receives only a server key and encrypted inputs.
use tfhe::boolean::prelude::*;

pub const MAX_INPUTS: usize = 4096;
pub const MAX_GATES: usize = 1_000_000;
pub const MAX_OUTPUTS: usize = 4096;

/// Inputs occupy wires 0..inputs. Gate i creates wire inputs+i.
#[derive(Clone, Debug)]
pub enum Gate {
    Not(usize), And(usize, usize), Or(usize, usize), Xor(usize, usize),
    Nand(usize, usize), Nor(usize, usize), Xnor(usize, usize),
    /// Selector, true branch, false branch.
    Mux(usize, usize, usize),
}

impl Gate {
    fn references(&self) -> Vec<usize> {
        match *self {
            Self::Not(a) => vec![a],
            Self::And(a,b)|Self::Or(a,b)|Self::Xor(a,b)|Self::Nand(a,b)|Self::Nor(a,b)|Self::Xnor(a,b) => vec![a,b],
            Self::Mux(a,b,c) => vec![a,b,c],
        }
    }
}

#[derive(Clone, Debug)]
pub struct Circuit { pub inputs: usize, pub gates: Vec<Gate>, pub outputs: Vec<usize> }

impl Circuit {
    /// Validate the entire DAG before performing any encrypted computation.
    pub fn validate(&self) -> Result<(), String> {
        if self.inputs == 0 || self.inputs > MAX_INPUTS { return Err("input count out of bounds".into()); }
        if self.gates.len() > MAX_GATES { return Err("gate budget exceeded".into()); }
        if self.outputs.is_empty() || self.outputs.len() > MAX_OUTPUTS { return Err("output count out of bounds".into()); }
        for (i,g) in self.gates.iter().enumerate() {
            if g.references().iter().any(|&r| r >= self.inputs+i) {
                return Err(format!("gate {i}: forward, cyclic or missing wire"));
            }
        }
        if self.outputs.iter().any(|&r| r >= self.inputs+self.gates.len()) { return Err("missing output wire".into()); }
        Ok(())
    }

    /// Arbitrary finite DAG, constrained by explicit resource limits.
    /// The caller must associate ciphertexts with the correct server key.
    /// This is not a proof of computation or an authenticated transport.
    pub fn evaluate(&self, key: &ServerKey, inputs: &[Ciphertext]) -> Result<Vec<Ciphertext>, String> {
        self.validate()?;
        if inputs.len() != self.inputs { return Err("encrypted input count mismatch".into()); }
        let mut wires = inputs.to_vec();
        for g in &self.gates {
            let value = match *g {
                Gate::Not(a) => key.not(&wires[a]),
                Gate::And(a,b) => key.and(&wires[a], &wires[b]),
                Gate::Or(a,b) => key.or(&wires[a], &wires[b]),
                Gate::Xor(a,b) => key.xor(&wires[a], &wires[b]),
                Gate::Nand(a,b) => key.nand(&wires[a], &wires[b]),
                Gate::Nor(a,b) => key.nor(&wires[a], &wires[b]),
                Gate::Xnor(a,b) => key.xnor(&wires[a], &wires[b]),
                Gate::Mux(s,a,b) => key.mux(&wires[s], &wires[a], &wires[b]),
            };
            wires.push(value);
        }
        Ok(self.outputs.iter().map(|&i| wires[i].clone()).collect())
    }
}

/// Compile unsigned addition, least-significant bit first, with carry output.
/// Inputs: bits of A, bits of B, carry-in. Outputs: sum bits, carry-out.
pub fn unsigned_adder(bits: usize) -> Result<Circuit, String> {
    if bits == 0 || bits > (MAX_INPUTS-1)/2 { return Err("adder width out of bounds".into()); }
    let inputs = 2*bits+1;
    let mut gates = Vec::new();
    let mut outputs = Vec::new();
    let mut carry = 2*bits;
    for i in 0..bits {
        let xor = inputs+gates.len(); gates.push(Gate::Xor(i,bits+i));
        let sum = inputs+gates.len(); gates.push(Gate::Xor(xor,carry));
        let ab = inputs+gates.len(); gates.push(Gate::And(i,bits+i));
        let xc = inputs+gates.len(); gates.push(Gate::And(xor,carry));
        let next = inputs+gates.len(); gates.push(Gate::Or(ab,xc));
        outputs.push(sum); carry=next;
    }
    outputs.push(carry);
    let circuit = Circuit { inputs, gates, outputs };
    circuit.validate()?;
    Ok(circuit)
}
