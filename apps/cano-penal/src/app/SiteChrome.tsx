import { Link } from "@nexus/core";
import { nav, site } from "./content";
import { ClientInteractions } from "./ClientInteractions";

function Logo({ placement }: { placement: "header" | "footer" }) {
  return <img className={`cp-logo cp-logo-${placement}`} src="/media/logo-cano.png" alt="CANO Estrategia Penal" />;
}

export function SiteHeader() {
  return (
    <header className="cp-header">
      <div className="cp-wrap cp-nav">
        <Link href="/" aria-label="CANO Estrategia Penal"><Logo placement="header" /></Link>
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
          <div><Logo placement="footer" /><div className="cp-footer-name">EDUARDO CANO</div></div>
          <nav className="cp-footer-links" aria-label="Navegación del pie de página">
            {nav.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}
          </nav>
          <div className="cp-footer-social">
            <a href={site.facebook} target="_blank" rel="noopener noreferrer" aria-label="Facebook"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 8h3V4h-3c-3 0-5 2-5 5v2H6v4h3v7h4v-7h3l1-4h-4V9c0-.7.3-1 1-1Z" /></svg></a>
            <a href={site.whatsapp} target="_blank" rel="noopener noreferrer" aria-label="WhatsApp"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 3.5A11.8 11.8 0 0 0 12.1 0 11.9 11.9 0 0 0 1.8 17.9L.1 24l6.3-1.6a12 12 0 0 0 5.7 1.4h.1A11.9 11.9 0 0 0 20.5 3.5Zm-8.3 18.3a10 10 0 0 1-5.1-1.4l-.4-.2-3.7 1 1-3.6-.3-.4a9.9 9.9 0 1 1 8.5 4.6Zm5.4-7.4c-.3-.2-1.8-.9-2.1-1-.3-.1-.5-.2-.7.2l-.9 1.1c-.2.2-.3.2-.6.1a8 8 0 0 1-2.4-1.5A9 9 0 0 1 9.2 11c-.2-.3 0-.5.1-.6l.5-.6.3-.6c.1-.2 0-.4 0-.6l-1-2.3c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.2-1.2 2.9s1.3 3.4 1.4 3.6c.2.2 2.5 3.8 6 5.3.8.4 1.5.6 2 .7.8.3 1.6.2 2.2.1.7-.1 1.8-.7 2.1-1.5.3-.7.3-1.4.2-1.5-.1-.2-.3-.3-.6-.4Z" /></svg></a>
            <a href={site.instagram} target="_blank" rel="noopener noreferrer" aria-label="Instagram"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5Zm0 2a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3H7Zm10.5 1.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" /></svg></a>
          </div>
        </div>
        <div className="cp-footer-bottom"><span>© 2026 CANO Estrategia Penal.</span><Link href="/aviso-de-privacidad">Aviso de privacidad</Link></div>
      </div>
      <a className="cp-wa" href={site.whatsapp} target="_blank" rel="noopener noreferrer" aria-label="WhatsApp"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 3.5A11.8 11.8 0 0 0 12.1 0 11.9 11.9 0 0 0 1.8 17.9L.1 24l6.3-1.6a12 12 0 0 0 5.7 1.4h.1A11.9 11.9 0 0 0 20.5 3.5Zm-8.3 18.3a10 10 0 0 1-5.1-1.4l-.4-.2-3.7 1 1-3.6-.3-.4a9.9 9.9 0 1 1 8.5 4.6Zm5.4-7.4c-.3-.2-1.8-.9-2.1-1-.3-.1-.5-.2-.7.2l-.9 1.1c-.2.2-.3.2-.6.1a8 8 0 0 1-2.4-1.5A9 9 0 0 1 9.2 11c-.2-.3 0-.5.1-.6l.5-.6.3-.6c.1-.2 0-.4 0-.6l-1-2.3c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.2-1.2 2.9s1.3 3.4 1.4 3.6c.2.2 2.5 3.8 6 5.3.8.4 1.5.6 2 .7.8.3 1.6.2 2.2.1.7-.1 1.8-.7 2.1-1.5.3-.7.3-1.4.2-1.5-.1-.2-.3-.3-.6-.4Z" /></svg></a>
    </footer>
  );
}

export function PageShell({ children }: { children: React.ReactNode }) {
  return <><ClientInteractions /><SiteHeader /><main id="main-content" className="cp-main">{children}</main><SiteFooter /></>;
}
