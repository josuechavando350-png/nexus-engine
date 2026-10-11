import test from "node:test";
import assert from "node:assert/strict";
import { validarPerfil, esYmyl } from "../core/perfil.mjs";
import { compararTerritorios, conflictosDe, mapaDeConflictos } from "../core/territorio.mjs";
import { construirEstrategia, configAvengers } from "../core/estratega.mjs";
import { cambiarEstado, cambiarInsumo, cambiarPlan, planDeApagado, resolverExposicion } from "../core/interruptor.mjs";
import { zonasSeTraslapan } from "../core/catalogo.mjs";
import { perfilBase, perfilCano } from "./fixtures.mjs";

const AHORA = new Date("2026-10-11T12:00:00Z");

test("el perfil real de Cano es válido, inmutable y del rubro penal", () => {
  const p = validarPerfil(perfilCano());
  assert.equal(p.id, "cano");
  assert.equal(p.dominio, "https://canopenal.com");
  assert.equal(esYmyl(p), true);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.insumos));
  assert.throws(() => { p.estado = "ON"; }, TypeError);
});

test("el perfil falla cerrado ante campos desconocidos, faltantes o mal formados", () => {
  const casos = [
    [{ ...perfilBase(), extra: 1 }, /campos desconocidos extra/],
    [(() => { const x = perfilBase(); delete x.marca; return x; })(), /faltan marca/],
    [perfilBase({ dominio: "http://despacho.mx" }), /https/],
    [perfilBase({ dominio: "https://despacho.mx/ruta" }), /solo origen/],
    [perfilBase({ rubro: "astrologia" }), /rubro/],
    [perfilBase({ plan: "PREMIUM" }), /plan/],
    [perfilBase({ estado: "TAL_VEZ" }), /estado/],
    [perfilBase({ contacto: { telefono: "55 1111 2222", whatsapp: null, direccion: null } }), /telefono/],
    [perfilBase({ servicios: [{ slug: "a", nombre: "Uno", ruta: "../etc" }] }), /ruta/],
    [perfilBase({ servicios: [{ slug: "a", nombre: "Uno", ruta: "/a" }, { slug: "a", nombre: "Dos", ruta: "/b" }] }), /repetidos/],
    [perfilBase({ territorio: { especialidades: [], zonas: ["cdmx"], exclusivo: false } }), /especialidades/],
    [perfilBase({ insumos: { search_console: "si", notas_voz: false, perfil_google: false, videos: false, revisor: null, terminos_ads: false } }), /search_console/],
    [perfilBase({ insumos: { search_console: false, notas_voz: false, perfil_google: false, videos: false, revisor: "MAMA", terminos_ads: false } }), /revisor/],
    [perfilBase({ historial: [{ en: "ayer", accion: "alta", detalle: "" }] }), /fecha ISO/],
  ];
  for (const [raw, patron] of casos) assert.throws(() => validarPerfil(raw), patron);
});

test("las zonas se traslapan por jerarquía", () => {
  assert.ok(zonasSeTraslapan("cdmx", "cdmx-iztapalapa"));
  assert.ok(zonasSeTraslapan("cdmx-iztapalapa", "cdmx"));
  assert.ok(zonasSeTraslapan("mx", "edomex"));
  assert.ok(!zonasSeTraslapan("cdmx-iztapalapa", "cdmx-coyoacan"));
  assert.ok(!zonasSeTraslapan("cdmx", "edomex"));
  assert.ok(!zonasSeTraslapan("cdmx", "cdmxx"));
});

test("territorio: exclusividad bloquea, compartido avisa, sin traslape no choca", () => {
  const cano = validarPerfil(perfilCano());
  const competidor = validarPerfil(perfilBase({ estado: "PREPARACION" }));
  const choque = compararTerritorios(cano, competidor);
  assert.equal(choque.severidad, "AVISO");
  assert.deepEqual(choque.especialidades, ["penal-patrimonial"]);
  assert.deepEqual(choque.zonas, ["cdmx ~ cdmx-iztapalapa"]);

  const canoExclusivo = validarPerfil({ ...perfilCano(), territorio: { ...perfilCano().territorio, exclusivo: true } });
  assert.equal(compararTerritorios(canoExclusivo, competidor).severidad, "BLOQUEO");

  const otraZona = validarPerfil(perfilBase({ territorio: { especialidades: ["penal-patrimonial"], zonas: ["edomex"], exclusivo: false } }));
  assert.equal(compararTerritorios(cano, otraZona), null);
  const otraEspecialidad = validarPerfil(perfilBase({ territorio: { especialidades: ["familiar"], zonas: ["cdmx"], exclusivo: false } }));
  assert.equal(compararTerritorios(cano, otraEspecialidad), null);
});

test("un cliente apagado no ocupa territorio", () => {
  const canoExclusivo = validarPerfil({ ...perfilCano(), estado: "OFF", territorio: { ...perfilCano().territorio, exclusivo: true } });
  const competidor = validarPerfil(perfilBase());
  assert.deepEqual(conflictosDe(competidor, [canoExclusivo]), []);
  assert.deepEqual(mapaDeConflictos([canoExclusivo, competidor]), []);
});

test("encender un cliente en territorio exclusivo ajeno queda bloqueado", () => {
  const canoExclusivo = validarPerfil({ ...perfilCano(), territorio: { ...perfilCano().territorio, exclusivo: true } });
  const competidor = validarPerfil(perfilBase());
  assert.throws(() => cambiarEstado(competidor, "ON", { cartera: [canoExclusivo], ahora: AHORA }), /TERRITORIO_OCUPADO/);
  assert.throws(() => cambiarEstado(competidor, "PREPARACION", { cartera: [canoExclusivo], ahora: AHORA }), /TERRITORIO_OCUPADO/);
  const apagado = cambiarEstado(competidor, "OFF", { cartera: [canoExclusivo], ahora: AHORA });
  assert.equal(apagado, competidor);
});

test("el interruptor registra cada cambio en el historial", () => {
  const p = validarPerfil(perfilBase());
  const on = cambiarEstado(p, "ON", { ahora: AHORA, motivo: "pagó la mensualidad" });
  assert.equal(on.estado, "ON");
  assert.deepEqual(on.historial.at(-1), { en: "2026-10-11T12:00:00Z", accion: "encender", detalle: "pagó la mensualidad" });
  const total = cambiarPlan(on, "TOTAL", { ahora: AHORA });
  assert.equal(total.historial.at(-1).detalle, "BASE → TOTAL");
  const conRevisor = cambiarInsumo(total, "revisor", "CLIENTE", { ahora: AHORA });
  assert.equal(conRevisor.insumos.revisor, "CLIENTE");
  assert.throws(() => cambiarInsumo(total, "revisor", "OTRO", { ahora: AHORA }), /revisor/);
  assert.throws(() => cambiarInsumo(total, "magia", true, { ahora: AHORA }), /INSUMO_INVALIDO/);
  assert.throws(() => cambiarPlan(total, "GRATIS"), /PLAN_INVALIDO/);
  assert.equal(p.estado, "OFF", "el perfil original no cambia");
});

test("la exposición en el sitio depende del estado", () => {
  const base = validarPerfil(perfilBase());
  const off = resolverExposicion(base);
  assert.equal(off.publica_paginas, false);
  assert.equal(off.redirige_paginas_superseo, true);
  assert.equal(off.exponer.analitica_propia, false);
  const prep = resolverExposicion(cambiarEstado(base, "PREPARACION", { ahora: AHORA }));
  assert.equal(prep.publica_paginas, false);
  assert.equal(prep.exponer.analitica_propia, true);
  assert.equal(prep.robots_paginas_superseo, "noindex,follow");
  const on = resolverExposicion(cambiarEstado(base, "ON", { ahora: AHORA }));
  assert.equal(on.publica_paginas, true);
  assert.equal(on.robots_paginas_superseo, "index,follow");
});

test("apagar nunca rompe el sitio: cada página redirige a su servicio sin cadenas", () => {
  const p = validarPerfil(perfilCano());
  const plan = planDeApagado(p, [
    { ruta: "/detenido-cdmx/iztapalapa", servicio: "detenciones" },
    { ruta: "/observatorio/iztapalapa", servicio: "desconocido" },
    { ruta: "/detenido-cdmx", servicio: "detenciones" },
  ]);
  assert.deepEqual(plan.map((r) => [r.desde, r.hacia, r.codigo]), [
    ["/detenido-cdmx", "/", 301],
    ["/detenido-cdmx/iztapalapa", "/", 301],
    ["/observatorio/iztapalapa", "/", 301],
  ]);
  const limpio = planDeApagado(p, [{ ruta: "/detenido-cdmx/coyoacan", servicio: "detenciones" }]);
  assert.deepEqual(limpio.map((r) => r.hacia), ["/detenido-cdmx"]);
  assert.throws(() => planDeApagado(p, [{ ruta: "sin-barra", servicio: "detenciones" }]), /PAGINA_INVALIDA/);
});

test("estrategia de Cano hoy: arranca con demanda prestada y contenido legal en borrador", () => {
  const e = construirEstrategia(validarPerfil(perfilCano()));
  assert.equal(e.potencia.puntos, 0);
  assert.equal(e.potencia.nivel, "BAJA");
  assert.equal(e.demanda.fuente, "PRESTADA");
  assert.equal(e.publicacion.politica, "REVISION_OBLIGATORIA");
  assert.equal(e.publicacion.sensible_en_borrador, true);
  assert.equal(e.activa, true);
  const activos = e.canales.filter((c) => c.activo).map((c) => c.id);
  assert.ok(activos.includes("paginas_torre") && activos.includes("arma:observatorio-delito"));
  assert.ok(!activos.includes("videos") && !activos.includes("perfil_google"));
  assert.equal(e.siguientes_pasos[0].insumo, "search_console");
  assert.equal(e.plan.tope, 200);
});

test("cada insumo cambia la estrategia sin bloquearla", () => {
  let p = validarPerfil(perfilCano());
  for (const [insumo, valor] of [["search_console", true], ["notas_voz", true], ["perfil_google", true], ["videos", true], ["revisor", "CLIENTE"], ["terminos_ads", true]]) {
    p = cambiarInsumo(p, insumo, valor, { ahora: AHORA });
  }
  const e = construirEstrategia(p);
  assert.equal(e.potencia.puntos, 100);
  assert.equal(e.potencia.nivel, "MAXIMA");
  assert.equal(e.demanda.fuente, "PROPIA");
  assert.ok(e.demanda.fuentes.includes("Términos de búsqueda de Ads"));
  assert.equal(e.voz.fuente, "CLIENTE");
  assert.equal(e.publicacion.sensible_en_borrador, false);
  assert.deepEqual(e.siguientes_pasos, []);
});

test("rubro no sensible publica con el candado de Avengers; plan Base guarda el arma", () => {
  const restaurante = validarPerfil(perfilBase({ id: "taqueria", rubro: "restaurante", territorio: { especialidades: ["tacos"], zonas: ["cdmx-tlalpan"], exclusivo: false } }));
  const e = construirEstrategia(restaurante);
  assert.equal(e.publicacion.politica, "CANDADO_AVENGERS");
  assert.equal(e.canales.find((c) => c.id === "arma:guia-gastronomica").activo, false);
  assert.equal(e.plan.tope, 120);
});

test("la estrategia es determinista y se liga al perfil exacto", () => {
  const p = validarPerfil(perfilCano());
  const a = construirEstrategia(p);
  const b = construirEstrategia(validarPerfil(perfilCano()));
  assert.equal(a.estrategia_digest, b.estrategia_digest);
  const otro = construirEstrategia(cambiarPlan(p, "BASE", { ahora: AHORA }));
  assert.notEqual(a.estrategia_digest, otro.estrategia_digest);
  assert.match(a.estrategia_digest, /^sha256:[0-9a-f]{64}$/);
});

test("la configuración de Avengers sale solo de lo declarado por el cliente", () => {
  const c = configAvengers(validarPerfil(perfilCano()));
  assert.deepEqual(c.local_brand_terms, ["cano estrategia penal", "eduardo cano", "cano penal"]);
  assert.ok(c.local_service_terms.includes("defensa de personas detenidas"));
  assert.deepEqual(c.local_location_groups.cdmx, ["cdmx", "ciudad de mexico"]);
  assert.ok(c.local_commercial_terms.includes("abogado penalista"));
  assert.ok(c.local_service_terms.every((t) => t === t.toLowerCase() && !/[áéíóú]/.test(t)));
});
