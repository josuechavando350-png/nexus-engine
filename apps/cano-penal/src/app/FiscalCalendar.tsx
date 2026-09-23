"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { FISCAL_EVENTS, MONTHS, type FiscalAudience } from "./fiscal-calendar-data";
import { site } from "./content";

type Audience = "ambas" | FiscalAudience;
const WEEKDAYS = ["L", "M", "M", "J", "V", "S", "D"] as const;
const WEEKDAY_LABELS = ["lunes","martes","miércoles","jueves","viernes","sábado","domingo"] as const;

export function FiscalCalendar() {
  const [month, setMonth] = useState(8);
  const [audience, setAudience] = useState<Audience>("ambas");
  const [selectedDay, setSelectedDay] = useState<number | null>(17);

  const events = useMemo(() => FISCAL_EVENTS.filter((event) =>
    event.month === month && (audience === "ambas" || event.audience === audience)
  ), [month, audience]);
  const daysInMonth = new Date(2026, month + 1, 0).getDate();
  const firstWeekday = (new Date(2026, month, 1).getDay() + 6) % 7;
  const displayed = selectedDay ? events.filter((event) => event.day === selectedDay) : events;
  const visibleDates = new Set(events.map((event) => event.day));

  function changeMonth(next: number) {
    const bounded = Math.max(0, Math.min(11, next));
    setMonth(bounded);
    setSelectedDay(17);
  }

  return (
    <section className="cp-cal-app" aria-label="Calendario fiscal de referencia 2026">
      <div className="cp-cal-app-top">
        <div>
          <span className="cp-cal-overline">Herramienta · 2026</span>
          <h2>El calendario, <em>con contexto.</em></h2>
          <p>Selecciona un mes y un perfil. Cada fecha indica su fuente y lo que necesitas verificar antes de actuar.</p>
        </div>
        <label className="cp-cal-filter">
          <span>Perfil fiscal</span>
          <select value={audience} onChange={(event) => {setAudience(event.target.value as Audience);setSelectedDay(17);}}>
            <option value="ambas">Todos los perfiles</option>
            <option value="fisica">Persona física</option>
            <option value="moral">Persona moral</option>
          </select>
        </label>
      </div>
      <div className="cp-cal-workspace">
        <div className="cp-cal-monthly">
          <div className="cp-cal-navigation">
            <button onClick={() => changeMonth(month - 1)} disabled={month === 0} type="button" aria-label="Mes anterior">←</button>
            <span aria-live="polite">{MONTHS[month]} <b>2026</b></span>
            <button onClick={() => changeMonth(month + 1)} disabled={month === 11} type="button" aria-label="Mes siguiente">→</button>
          </div>
          <div className="cp-cal-month-strip" aria-label="Seleccionar mes">
            {MONTHS.map((name, index) => (
              <button type="button" key={name} className={index === month ? "is-current" : ""} onClick={() => changeMonth(index)} aria-pressed={index === month}>
                {name.slice(0,3)}
              </button>
            ))}
          </div>
          <div className="cp-cal-grid" role="group" aria-label={`Días de ${MONTHS[month]} de 2026`}>
            {WEEKDAYS.map((day,index) => <span className="cp-cal-weekday" key={index} aria-label={WEEKDAY_LABELS[index]}>{day}</span>)}
            {Array.from({length:firstWeekday},(_,i) => <span aria-hidden="true" key={`blank-${i}`} className="cp-cal-blank" />)}
            {Array.from({length:daysInMonth},(_,i)=>{
              const day=i+1;
              const hasEvent=visibleDates.has(day);
              return hasEvent ? (
                <button key={day} type="button" className={`cp-cal-day cp-cal-day-event${selectedDay===day?" is-selected":""}`}
                  onClick={()=>setSelectedDay(selectedDay===day?null:day)}
                  aria-pressed={selectedDay===day} aria-label={`${day} de ${MONTHS[month]}: ${events.filter(event=>event.day===day).length} referencias`}>
                  <span>{day}</span><i aria-hidden="true" />
                </button>
              ) : <span className="cp-cal-day" key={day}>{day}</span>;
            })}
          </div>
          <p className="cp-cal-legend"><span aria-hidden="true" /> Fechas de referencia con fuente oficial. No son plazos personalizados.</p>
        </div>
        <div className="cp-cal-agenda">
          <div className="cp-cal-agenda-header">
            <span>Detalle del mes</span>
            <strong>{String(displayed.length).padStart(2,"0")} referencias</strong>
          </div>
          {displayed.length ? displayed.map((event)=>(
            <article className="cp-cal-entry" key={event.id}>
              <div className="cp-cal-entry-date"><strong>{String(event.day).padStart(2,"0")}</strong><span>{MONTHS[month].slice(0,3)}</span></div>
              <div>
                <p className="cp-cal-audience">{event.audience==="fisica"?"PERSONA FÍSICA":"PERSONA MORAL"} · {event.type==="GENERAL_REFERENCE"?"DÍA GENERAL":"FECHA PUBLICADA"}</p>
                <h3>{event.title}</h3>
                <p className="cp-cal-period">Periodo: {event.period}</p>
                <p className="cp-cal-notice">{event.note}</p>
                <a href={event.sourceUrl} rel="noopener noreferrer" target="_blank">Ver fuente oficial SAT ↗</a>
                <span className="cp-cal-verified">Fuente revisada: 23 septiembre 2026</span>
              </div>
            </article>
          )):<div className="cp-cal-empty">No hay referencias para el filtro seleccionado. Puedes cambiar el día, el mes o el perfil.</div>}
          <p className="cp-cal-legal">Las obligaciones dependen del régimen y de la situación de cada contribuyente. Este calendario es informativo; verifica siempre el plazo aplicable directamente en el SAT.</p>
        </div>
      </div>
      <div className="cp-cal-bridge">
        <div>
          <span>Cuando el asunto deja de ser sólo administrativo</span>
          <p>Una notificación fiscal puede requerir revisar el contexto antes de tomar decisiones. La asesoría penal-fiscal es distinta de preparar declaraciones.</p>
        </div>
        <div>
          <Link href="/areas/delitos-fiscales-y-financieros">Conocer la defensa penal-fiscal ↗</Link>
          <a href={site.whatsapp} target="_blank" rel="noopener noreferrer">Hablar con CANO ↗</a>
        </div>
      </div>
    </section>
  );
}
