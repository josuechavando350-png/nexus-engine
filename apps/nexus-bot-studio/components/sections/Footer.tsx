import { Card } from "@/components/ui/Card";
import { Reveal } from "@/components/ui/Reveal";

export function Footer() {
  return (
    <footer id="contacto" className="site-footer">
      <div className="footer-grid">
        <Reveal>
          <Card className="footer-block">
            <p><span className="label">NEXUS BOT STUDIO</span> — Creamos sistemas que impulsan tu negocio.</p>
          </Card>
        </Reveal>

        <div>
          <Reveal><p className="footer-statement">CONSTRUYAMOS ALGO EXTRAORDINARIO JUNTOS.</p></Reveal>
          <div className="footer-process">
            <Reveal delay={80}><Card className="footer-block"><span className="label">PLANEA</span><span>Pensamos estratégico.</span></Card></Reveal>
            <Reveal delay={160}><Card className="footer-block"><span className="label">DISEÑAMOS</span><span>Diseñamos con detalle.</span></Card></Reveal>
            <Reveal delay={240}><Card className="footer-block"><span className="label">ESCALAMOS</span><span>Hacemos crecer con inteligencia.</span></Card></Reveal>
          </div>
        </div>

        <Reveal>
          <Card className="footer-block footer-contact">
            <span className="label">CONTACTO</span>
            <span>Conversemos. Tu próximo sistema te está esperando.</span>
            <span>Nexus Bot Studio — México</span>
            <div className="socials" aria-label="Redes sociales"><span>LinkedIn</span><span>Instagram</span><span>WhatsApp</span></div>
          </Card>
        </Reveal>
        <div className="footer-legal">© 2026 Nexus Bot Studio. Todos los derechos reservados.</div>
      </div>
    </footer>
  );
}
