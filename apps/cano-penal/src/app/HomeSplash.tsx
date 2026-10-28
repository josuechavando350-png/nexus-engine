const SPLASH_SESSION_KEY = "cano:splash-shown:v1";

/**
 * Click identifiers Google Ads appends to the landing URL when auto-tagging is on
 * (gclid on most traffic, gbraid/wbraid on some iOS traffic). Only a visit that
 * arrives with one of these in the URL is treated as coming from an ad.
 */
export const AD_CLICK_PARAMS = ["gclid", "gbraid", "wbraid"] as const;

/*
 * The splash is part of the server HTML so it covers the page from the very first paint.
 * (Before, it only mounted after hydration, so the content flashed first and the splash
 * popped in on top of it.) The inline script runs synchronously while the HTML is parsed,
 * before the browser paints: on repeat visits in the same session it hides the splash, and
 * on the first visit it locks scrolling until the exit animation ends. Without JavaScript
 * the CSS animation alone still plays and hides it.
 *
 * Visitors who arrive from a Google Ads click (approved by the client, Oct 2026) skip the
 * full-screen splash so the page is usable from the first paint, which is what Google
 * scores as landing page experience. They still get the brand moment: `data-ad` reveals
 * the in-hero brand mark (logo, line and tagline with the same animation). Every other
 * visitor keeps the splash exactly as before.
 */
export const SPLASH_SCRIPT = `(function(){var s=document.currentScript&&document.currentScript.previousElementSibling;if(!s)return;var ad=false;try{ad=/[?&](?:${AD_CLICK_PARAMS.join("|")})=[^&]/.test(window.location.search);}catch(e){}var seen=false;try{seen=sessionStorage.getItem(${JSON.stringify(SPLASH_SESSION_KEY)})==="1";if(!seen)sessionStorage.setItem(${JSON.stringify(SPLASH_SESSION_KEY)},"1");}catch(e){}if(ad){s.setAttribute("data-ad","");s.setAttribute("data-skip","");return;}if(seen){s.setAttribute("data-skip","");return;}var r=document.documentElement;r.classList.add("cp-splash-lock");var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;setTimeout(function(){r.classList.remove("cp-splash-lock");s.setAttribute("data-done","");},reduce?950:2200);})();`;

export function HomeSplash() {
  return (
    <>
      <div className="cp-splash" aria-hidden="true" suppressHydrationWarning>
        <div className="cp-splash-inner">
          <div className="cp-splash-logo-wrap">
            <img className="cp-splash-logo" src="/media/logo-cano.png" alt="" fetchPriority="high" />
          </div>
          <div className="cp-splash-line" />
          <p>EXPERIENCIA DESDE DENTRO. DEFENSA DE FRENTE.</p>
        </div>
      </div>
      <script dangerouslySetInnerHTML={{ __html: SPLASH_SCRIPT }} />
    </>
  );
}
