import type { Redirect } from "next/dist/lib/load-custom-routes";

export const redirects: Redirect[] = [
  {
    source: "/acerca-de",
    destination: "/acerca-de-mi",
    permanent: true
  }
];
