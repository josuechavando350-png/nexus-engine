use nemesis_fhe::{unsigned_adder, Circuit, Gate};
use tfhe::boolean::gen_keys;
use std::io::{self, Read};

// Conservative limits for the CLI, distinct from the larger Rust library budgets.
const MAX_CLI_INPUTS: usize = 128;
const MAX_CLI_GATES: usize = 2048;
const MAX_CLI_OUTPUTS: usize = 128;

fn index(text: &str) -> Result<usize, String> {
    if text.is_empty() || (text.len() > 1 && text.starts_with('0')) || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err("wire index must be canonical unsigned decimal".into());
    }
    text.parse().map_err(|_| "wire index out of range".into())
}

fn parse_circuit(bits: &str, gates: &str, outputs: &str) -> Result<(Circuit, Vec<bool>), String> {
    if bits.is_empty() || bits.len() > MAX_CLI_INPUTS || !bits.bytes().all(|b| b == b'0' || b == b'1') {
        return Err("input bits must be a bounded binary string".into());
    }
    let inputs: Vec<bool> = bits.bytes().map(|b| b == b'1').collect();
    let mut parsed = Vec::new();
    if !gates.is_empty() {
        // Check the count before splitting into a potentially huge vector.
        if gates.bytes().filter(|&b| b == b';').count() >= MAX_CLI_GATES {
            return Err("CLI gate budget exceeded".into());
        }
        for raw in gates.split(';') {
            let fields: Vec<&str> = raw.split(':').collect();
            let g = match fields.as_slice() {
                ["not",a] => Gate::Not(index(a)?),
                ["and",a,b] => Gate::And(index(a)?,index(b)?),
                ["or",a,b] => Gate::Or(index(a)?,index(b)?),
                ["xor",a,b] => Gate::Xor(index(a)?,index(b)?),
                ["nand",a,b] => Gate::Nand(index(a)?,index(b)?),
                ["nor",a,b] => Gate::Nor(index(a)?,index(b)?),
                ["xnor",a,b] => Gate::Xnor(index(a)?,index(b)?),
                ["mux",s,a,b] => Gate::Mux(index(s)?,index(a)?,index(b)?),
                _ => return Err("malformed or unknown gate".into()),
            };
            parsed.push(g);
        }
    }
    if outputs.is_empty() || outputs.split(',').count() > MAX_CLI_OUTPUTS {
        return Err("CLI output count out of bounds".into());
    }
    let output_wires: Vec<usize> = outputs.split(',').map(index).collect::<Result<_,_>>()?;
    let circuit = Circuit { inputs: inputs.len(), gates: parsed, outputs: output_wires };
    circuit.validate()?;
    Ok((circuit, inputs))
}

fn read_private_stdin(max: u64) -> Result<String, String> {
    let mut raw = Vec::new();
    io::stdin().take(max+1).read_to_end(&mut raw).map_err(|_|"cannot read private stdin")?;
    if raw.len() as u64 > max { return Err("private input too large".into()); }
    String::from_utf8(raw).map_err(|_|"private input is not UTF-8".into())
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    // Never accept secret bits or plaintext operands from argv: other local
    // processes may inspect command lines. Only the circuit topology is public.
    if args.len() == 4 && args[1] == "--circuit-stdin" {
        let private_bits = read_private_stdin(MAX_CLI_INPUTS as u64)?;
        let (circuit,inputs)=parse_circuit(&private_bits,&args[2],&args[3])?;
        let (client,server)=gen_keys();
        let encrypted:Vec<_>=inputs.into_iter().map(|bit|client.encrypt(bit)).collect();
        let decrypted:Vec<bool>=circuit.evaluate(&server,&encrypted)?.iter().map(|x|client.decrypt(x)).collect();
        let output=decrypted.iter().map(|bit|if *bit {"true"}else{"false"}).collect::<Vec<_>>().join(",");
        println!("{{\"motor\":89,\"backend\":\"TFHE_BOOLEAN\",\"outputs\":[{output}],\"verified\":true}}");
        return Ok(());
    }
    if args.len() != 2 || args[1] != "--add-stdin" {
        return Err("usage: nemesis-fhe --add-stdin | --circuit-stdin <gates> <outputs>; private values must arrive on stdin".into());
    }
    let (first,second) = {
        let input=read_private_stdin(7)?;
        let items:Vec<&str>=input.split_ascii_whitespace().collect();
        if items.len()!=2 { return Err("expected two private decimal bytes".into()); }
        (items[0].to_owned(),items[1].to_owned())
    };
    let a: u8=first.parse().map_err(|_|"invalid first byte")?;
    let b: u8=second.parse().map_err(|_|"invalid second byte")?;
    let (client,server)=gen_keys();
    let plain: Vec<bool>=(0..8).map(|i| ((a>>i)&1)==1)
        .chain((0..8).map(|i| ((b>>i)&1)==1)).chain(std::iter::once(false)).collect();
    let encrypted: Vec<_>=plain.iter().map(|&x|client.encrypt(x)).collect();
    let output=unsigned_adder(8)?.evaluate(&server,&encrypted)?;
    let sum: u16=output.iter().enumerate().map(|(i,c)|u16::from(client.decrypt(c))<<i).sum();
    if sum!=u16::from(a)+u16::from(b) { return Err("decrypted result differs from independent integer oracle".into()); }
    println!("{{\"motor\":89,\"backend\":\"TFHE_BOOLEAN\",\"sum\":{sum},\"verified\":true}}");
    Ok(())
}
fn main() -> Result<(), String> { run() }

#[cfg(test)]
mod tests {
    use super::parse_circuit;
    #[test]
    fn parses_dag_and_rejects_untrusted_formats() {
        let (c,bits)=parse_circuit("101","xor:0:1;mux:2:3:0","3,4").unwrap();
        assert_eq!(bits,vec![true,false,true]);
        assert_eq!(c.gates.len(),2);
        assert_eq!(c.outputs,vec![3,4]);
        for (bits,gates,outputs) in [
            ("", "", "0"), ("10x", "", "0"), ("1", "xor:0:1", "1"),
            ("1", "not:01", "1"), ("1", "or:0:0;", "1"),
            ("1", "unknown:0", "1"), ("1", "", "1"),
            ("1", "", ""), ("1", "", "00"),
        ] { assert!(parse_circuit(bits,gates,outputs).is_err(),"{bits} {gates} {outputs}"); }
    }
}
