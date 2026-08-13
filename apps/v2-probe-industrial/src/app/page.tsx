import { plan } from "./experience";
const rows=[
  ["M-01","PUMP / ROTARY","24H","ACTIVE","98.7%"],
  ["M-02","HVAC / CONTROL","12H","ACTIVE","99.1%"],
  ["M-03","POWER / UPS","4H","PRIORITY","97.9%"],
  ["M-04","WATER / LOOP","48H","ACTIVE","99.5%"]
] as const;
export default function Page(){return <main id="main-content" className="in-shell" data-recipe={plan.recipeId}>
<header className="in-top"><a href="#system" className="in-mark">UNIT 08 / OPS</a><div className="in-live"><span/>SYSTEM ONLINE</div><nav aria-label="Utility"><a href="#matrix">CAPABILITIES</a><a href="#quote">RFQ</a></nav></header>
<section id="system" className="in-intro"><div className="in-code">08—A / FACILITY SYSTEMS</div><h1>Maintenance infrastructure for teams that cannot guess.</h1><div className="in-meta"><span>REGION / MX</span><span>SLA / 24—48H</span><span>REV / 2026.08</span></div></section>
<section id="matrix" className="in-matrix" aria-labelledby="matrix-title"><div className="in-matrix-head"><h2 id="matrix-title">SERVICE MATRIX</h2><span>STATUS / LIVE DEMO</span></div><div className="in-row in-labels"><span>ID</span><span>SYSTEM</span><span>RESPONSE</span><span>STATE</span><span>UPTIME</span></div>{rows.map(r=><div className="in-row" key={r[0]}>{r.map((v,i)=><span key={v} className={i===3&&v==="PRIORITY"?"in-priority":""}>{v}</span>)}</div>)}</section>
<section className="in-bands"><article><b>01</b><h2>Inspection</h2><p>Structured evidence before intervention.</p><span>DISCOVERY / PROOF</span></article><article><b>02</b><h2>Response</h2><p>Operational path, owner and expected window.</p><span>UTILITY / TRUST</span></article><article><b>03</b><h2>Trace</h2><p>A record designed for the next decision.</p><span>PROOF / RETENTION</span></article></section>
<section id="quote" className="in-rfq"><div><span>REQUEST / RFQ</span><h2>Send scope.<br/>Get a route.</h2></div><form><label>FACILITY<input placeholder="Plant / building / site"/></label><label>SYSTEM<input placeholder="System or asset"/></label><button type="button">CREATE REQUEST →</button></form></section>
<footer className="in-footer"><span>UNIT 08 — NEXUS V2 PROBE</span><span>NO MARKETING HERO / NO CARDS / NO MOTION DEPENDENCY</span></footer>
</main>}
