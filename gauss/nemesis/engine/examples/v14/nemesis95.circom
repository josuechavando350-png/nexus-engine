pragma circom 2.1.6;
template Nemesis95() {
    signal input w[3];
    signal output out;
    signal n0;
    signal n1;
    signal n2;
    n0 <== w[0] * w[1];
    n1 <== n0 - 3;
    w[2] * (w[2] - 1) === 0;
    n2 <== w[0] + w[2] * (n1 - w[0]);
    out <== n2;
}
component main = Nemesis95();
