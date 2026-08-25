import { Link } from "@nexus/core";
import { nav, site } from "./content";

function Logo() {
  return <img className="cp-logo" src="/media/logo-cano.png" alt="CANO Estrategia Penal" />;
}

export function SiteHeader() {
  return (
    <header className="cp-header">
      <div className="cp-wrap cp-nav">
        <Link href="/" aria-label="CANO Estrategia Penal"><Logo /></Link>
        <nav className="cp-navlinks" aria-label="Navegación principal">
          {nav.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}
        </nav>
        <Link className="cp-btn cp-header-cta" href="/#contacto">Hablemos →</Link>
        <details className="cp-mobile-nav">
          <summary aria-label="Abrir menú"><span aria-hidden="true">☰</span></summary>
          <nav aria-label="Navegación móvil">
            {nav.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}
            <Link className="cp-btn" href="/#contacto">Hablemos →</Link>
          </nav>
        </details>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="cp-footer">
      <div className="cp-wrap">
        <div className="cp-footer-grid">
          <div><Logo /></div>
          <div className="cp-footer-links">
            {nav.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}
          </div>
          <div className="cp-footer-links">
            <a href={site.facebook} target="_blank" rel="noopener noreferrer">Facebook</a>
            <a href={site.whatsapp} target="_blank" rel="noopener noreferrer">WhatsApp</a>
            <a href={site.instagram} target="_blank" rel="noopener noreferrer">Instagram</a>
            <Link href="/aviso-de-privacidad">Aviso de privacidad</Link>
          </div>
        </div>
        <div className="cp-footer-bottom"><span>© 2026 CANO Estrategia Penal.</span></div>
      </div>
      <a className="cp-wa" href={site.whatsapp} target="_blank" rel="noopener noreferrer" aria-label="WhatsApp">WA</a>
    </footer>
  );
}

export function PageShell({ children }: { children: React.ReactNode }) {
  return <><SiteHeader /><main id="main-content" className="cp-main">{children}</main><SiteFooter /></>;
}
