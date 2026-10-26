const SPLASH_SESSION_KEY = "cano:splash-shown:v1";

/*
 * The splash is part of the server HTML so it covers the page from the very first paint.
 * (Before, it only mounted after hydration, so the content flashed first and the splash
 * popped in on top of it.) The inline script runs synchronously while the HTML is parsed,
 * before the browser paints: on repeat visits in the same session it hides the splash, and
 * on the first visit it locks scrolling until the exit animation ends. Without JavaScript
 * the CSS animation alone still plays and hides it.
 */
const SPLASH_SCRIPT = `(function(){var s=document.currentScript&&document.currentScript.previousElementSibling;if(!s)return;var seen=false;try{seen=sessionStorage.getItem(${JSON.stringify(SPLASH_SESSION_KEY)})==="1";if(!seen)sessionStorage.setItem(${JSON.stringify(SPLASH_SESSION_KEY)},"1");}catch(e){}if(seen){s.setAttribute("data-skip","");return;}var r=document.documentElement;r.classList.add("cp-splash-lock");var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;setTimeout(function(){r.classList.remove("cp-splash-lock");s.setAttribute("data-done","");},reduce?950:2200);})();`;

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
