import { Link } from "@nexus/core";
import { nav, site } from "./content";

export function SiteHeader() {
  return (
    <header className="cp-header">
      <div className="cp-wrap cp-nav">
        <Link href="/" aria-label="CANO Estrategia Penal">
          <img className="cp-logo" src="/media/logo-cano.png" alt="CANO | Estrategia Penal" />
        </Link>
        <nav className="cp-navlinks" aria-label="Navegación principal">
          {nav.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}
        </nav>
        <Link className="cp-btn" href="/#contacto">Hablemos →</Link>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="cp-footer">
      <div className="cp-wrap">
        <div className="cp-footer-grid">
          <div><img className="cp-logo" src="/media/logo-cano.png" alt="CANO | Estrategia Penal" /></div>
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
        <div className="cp-footer-bottom"><span>© 2026 CANO Estrategia Penal.</span><span>Defensa penal estratégica · CDMX</span></div>
      </div>
      <a className="cp-wa" href={site.whatsapp} target="_blank" rel="noopener noreferrer" aria-label="WhatsApp">WA</a>
    </footer>
  );
}

export function PageShell({ children }: { children: React.ReactNode }) {
  return <><SiteHeader /><main id="main-content" className="cp-main">{children}</main><SiteFooter /></>;
}
