import { Link } from "@nexus/core";
import { site } from "../content";
import { CONSULTA_PHONE_LABEL } from "./landing";

const WHATSAPP_PATH = "M20.5 3.5A11.8 11.8 0 0 0 12.1 0 11.9 11.9 0 0 0 1.8 17.9L.1 24l6.3-1.6a12 12 0 0 0 5.7 1.4h.1A11.9 11.9 0 0 0 20.5 3.5Zm-8.3 18.3a10 10 0 0 1-5.1-1.4l-.4-.2-3.7 1 1-3.6-.3-.4a9.9 9.9 0 1 1 8.5 4.6Zm5.4-7.4c-.3-.2-1.8-.9-2.1-1-.3-.1-.5-.2-.7.2l-.9 1.1c-.2.2-.3.2-.6.1a8 8 0 0 1-2.4-1.5A9 9 0 0 1 9.2 11c-.2-.3 0-.5.1-.6l.5-.6.3-.6c.1-.2 0-.4 0-.6l-1-2.3c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.2-1.2 2.9s1.3 3.4 1.4 3.6c.2.2 2.5 3.8 6 5.3.8.4 1.5.6 2 .7.8.3 1.6.2 2.2.1.7-.1 1.8-.7 2.1-1.5.3-.7.3-1.4.2-1.5-.1-.2-.3-.3-.6-.4Z";

export function WhatsappGlyph({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d={WHATSAPP_PATH} fill="currentColor" /></svg>;
}

/**
 * The landing keeps the site's logo but drops the navigation: an ad visitor has one decision to
 * make, and the phone number stays in reach at the top. The class cp-header keeps the site's
 * fixed, transparent-over-hero behaviour that ClientInteractions already drives.
 */
export function LandingHeader() {
  return (
    <header className="cp-header cp-lp-header">
      <div className="cp-wrap cp-nav cp-lp-nav">
        <Link href="/" aria-label="CANO Estrategia Penal, ir al sitio"><img className="cp-logo cp-logo-header" src="/media/logo-cano.png" alt="CANO Estrategia Penal" /></Link>
        <a className="cp-lp-header-call" href={site.phoneHref} data-nexus-signal="lp-header-call"><span className="cp-lp-header-call-label">Llamar al </span>{CONSULTA_PHONE_LABEL}</a>
      </div>
    </header>
  );
}
