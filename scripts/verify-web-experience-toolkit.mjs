#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateRegistry, selectModules, validateGitlink, parseGitlinks } from "./web-experience.mjs";
import { mountPhotoSwipe, mountEmbla, canUseImmersiveExperience } from "../packages/experimental/web-experience/index.ts";

const registry = JSON.parse(readFileSync(new URL("../vendor/web-experience/registry.json", import.meta.url), "utf8"));
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`PASS ${name}`); }
function changed(mutator) { const copy = structuredClone(registry); mutator(copy); return copy; }

check("exactly four registered modules", () => assert.equal(validateRegistry(registry).modules.length, 4));
check("all selector", () => assert.equal(selectModules(registry, ["all"]).length, 4));
check("selective loading", () => assert.deepEqual(selectModules(registry, ["photoswipe"]).map((x) => x.id), ["photoswipe"]));
check("reject unknown selector", () => assert.throws(() => selectModules(registry, ["../outside"])));
check("reject duplicate selection", () => assert.throws(() => selectModules(registry, ["photoswipe", "photoswipe"])));
check("reject incomplete catalog", () => assert.throws(() => validateRegistry(changed((x) => x.modules.pop()))));
check("reject duplicate ids", () => assert.throws(() => validateRegistry(changed((x) => x.modules[1] = x.modules[0]))));
check("reject traversal", () => assert.throws(() => validateRegistry(changed((x) => x.modules[0].path = "../outside"))));
check("reject floating revision", () => assert.throws(() => validateRegistry(changed((x) => x.modules[0].commit = "master"))));
check("reject executable URL scheme", () => assert.throws(() => validateRegistry(changed((x) => x.modules[0].repository = "ext::command"))));
check("reject missing license fingerprint", () => assert.throws(() => validateRegistry(changed((x) => x.modules[0].licenseBlob = ""))));
check("reject arbitrary fifth identity", () => assert.throws(() => validateRegistry(changed((x) => x.modules[0].id = "other"))));
check("correct gitlink", () => {
  const e = registry.modules[0];
  validateGitlink(e, `160000 ${e.commit} 0\t${e.path}`);
});
check("reject gitlink drift", () => {
  const e = registry.modules[0];
  assert.throws(() => validateGitlink(e, `160000 ${"0".repeat(40)} 0\t${e.path}`));
});
check("reject non-submodule index entry", () => {
  const e = registry.modules[0];
  assert.throws(() => validateGitlink(e, `100644 ${e.commit} 0\t${e.path}`));
});
check("reject conflicted gitlink", () => {
  const e = registry.modules[0];
  assert.throws(() => validateGitlink(e, `160000 ${e.commit} 2\t${e.path}`));
});
check("reject malformed git output", () => assert.throws(() => parseGitlinks("invalid")));
check("gallery lifecycle and reduced motion", () => {
  let initialized = 0; let destroyed = 0;
  const gallery = {};
  const stop = mountPhotoSwipe(gallery, (options) => {
    assert.equal(options.gallery, gallery);
    assert.equal(options.showHideAnimationType, "none");
    assert.equal(options.zoomAnimationDuration, 0);
    return { init: () => initialized++, destroy: () => destroyed++ };
  }, true);
  assert.equal(initialized, 1); stop(); stop(); assert.equal(destroyed, 1);
});
check("gallery leaves normal animation defaults to provider", () => {
  mountPhotoSwipe({}, (options) => {
    assert.equal(options.showHideAnimationType, undefined);
    return { init() {}, destroy() {} };
  }, false)();
});
check("failed gallery initialization is cleaned up", () => {
  let cleaned = false;
  assert.throws(() => mountPhotoSwipe({}, () => ({
    init() { throw new Error("provider failed"); }, destroy() { cleaned = true; },
  }), false), /provider failed/);
  assert.equal(cleaned, true);
});
function button(disabled = false) {
  const listeners = new Map();
  return { disabled, listeners, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
}
check("carousel controls, native buttons, cleanup and reduced motion", () => {
  const previous = button(true); const next = button();
  const listeners = new Map(); let destroyed = 0; let jumped;
  const stop = mountEmbla({}, (_viewport, options) => {
    assert.equal(options.duration, 0); assert.equal(options.loop, false);
    return {
      scrollPrev: (jump) => jumped = jump, scrollNext: (jump) => jumped = jump,
      canScrollPrev: () => false, canScrollNext: () => true,
      on: (name, fn) => listeners.set(name, fn), off: (name) => listeners.delete(name),
      destroy: () => destroyed++,
    };
  }, { previous, next }, true);
  assert.equal(previous.disabled, true); assert.equal(next.disabled, false);
  next.listeners.get("click")(); assert.equal(jumped, true);
  assert.equal(listeners.size, 2); stop(); stop();
  assert.equal(destroyed, 1); assert.equal(listeners.size, 0);
  assert.equal(previous.listeners.size + next.listeners.size, 0);
  assert.equal(previous.disabled, true); assert.equal(next.disabled, false);
});
check("failed carousel initialization is cleaned up", () => {
  const previous = button(); const next = button(); let destroyed = 0;
  assert.throws(() => mountEmbla({}, () => ({
    scrollPrev() {}, scrollNext() {}, canScrollPrev() { throw new Error("broken provider"); }, canScrollNext() { return true; },
    on() {}, off() {}, destroy() { destroyed++; },
  }), { previous, next }, false), /broken provider/);
  assert.equal(destroyed, 1);
  assert.equal(previous.listeners.size + next.listeners.size, 0);
});
const allowed = { enabled: true, reducedMotion: false, reducedData: false, webglAvailable: true };
check("immersive effects require explicit opt-in", () => assert.equal(canUseImmersiveExperience({ ...allowed, enabled: false }), false));
check("immersive effects honor reduced motion", () => assert.equal(canUseImmersiveExperience({ ...allowed, reducedMotion: true }), false));
check("immersive effects honor reduced data", () => assert.equal(canUseImmersiveExperience({ ...allowed, reducedData: true }), false));
check("immersive effects need WebGL", () => assert.equal(canUseImmersiveExperience({ ...allowed, webglAvailable: false }), false));
check("immersive effects enabled only with all conditions", () => assert.equal(canUseImmersiveExperience(allowed), true));
check("missing capability signals fail closed", () => assert.equal(canUseImmersiveExperience({ enabled: true, webglAvailable: true }), false));
check("nonboolean opt-in fails closed", () => assert.equal(canUseImmersiveExperience({ ...allowed, enabled: "true" }), false));
console.log(`${passed} checks passed. These are contract tests, not browser or full-engine certification.`);
