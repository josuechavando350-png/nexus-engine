# Adaptive Luxury V2

V2 adds an execution resolver on top of the reliable signals established in V1.2.

Inputs:

- `prefers-reduced-motion`
- `prefers-reduced-data`
- hover capability
- precise pointer capability
- declared execution budget

Explicitly excluded:

- `navigator.deviceMemory`
- `navigator.connection`
- viewport width as a proxy for device capability

The resolver can allow or deny optional premium capabilities while preserving the same identity and content meaning. Its tiers (`essential`, `enhanced`, `immersive`) describe execution cost, not aesthetic quality.

Premium capability definitions cover cinematic video, scroll choreography, View Transitions, WebGL, WebGPU, shaders, spatial interaction, canvas, 3D, high-end typography and responsive art direction. Every expensive capability declares a fallback strategy.
