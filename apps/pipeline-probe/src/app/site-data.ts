import type { SiteData } from "./generated-types";
export const site: SiteData = {
  "projectId": "pipeline-probe",
  "brand": "CANO Estrategia Penal",
  "routes": [
    {
      "path": "/",
      "navLabel": "Inicio"
    },
    {
      "path": "/explore",
      "navLabel": "Conoce"
    },
    {
      "path": "/proof",
      "navLabel": "Confianza"
    },
    {
      "path": "/visit",
      "navLabel": "Ubicación"
    },
    {
      "path": "/contact",
      "navLabel": "Contacto"
    }
  ],
  "routeContent": [
    {
      "path": "/",
      "navLabel": "Inicio",
      "purpose": "Establish a point of view before asking for action.",
      "capabilityIds": [
        "contact",
        "whatsapp"
      ],
      "copyRoles": [
        "differentiators",
        "headline",
        "primary-cta",
        "value-proposition"
      ],
      "mediaRoles": [
        "hero-media"
      ],
      "copy": [
        {
          "role": "differentiators",
          "text": "Soy abogado especialista en derecho penal. No soy generalista y aunque las conozco, no atiendo otras ramas del derecho. · Tu caso lo atiendo personalmente. La estrategia la diseño directamente, no la delego. · No hay intermediarios. Mantengo comunicación constante para que sepas en todo momento qué sucede con tu caso.",
          "sourceId": "nexus-grounded-copy:differentiators:a73bbe2e5955e8dd"
        },
        {
          "role": "headline",
          "text": "CANO Estrategia Penal",
          "sourceId": "nexus-grounded-copy:headline:5fcf859001675aa7"
        },
        {
          "role": "primary-cta",
          "text": "Hablemos de tu caso",
          "sourceId": "nexus-grounded-copy:primary-cta:c08047a0718027fb"
        },
        {
          "role": "value-proposition",
          "text": "Despacho especializado en derecho penal en Ciudad de México.",
          "sourceId": "nexus-grounded-copy:value-proposition:5cfcff9fd1ae0305"
        }
      ],
      "media": [
        {
          "assetId": "eduardo-cano-desk",
          "role": "hero-media",
          "publicPath": "/media/eduardo-cano-escritorio.jpg",
          "sourceDigest": "sha256:c2f01018d086287e9f4a496ed93c9924d16dad7c8990f919b245208c5809d3b3",
          "alt": "Eduardo Cano en su escritorio."
        }
      ],
      "actions": [
        {
          "capabilityId": "whatsapp",
          "label": "Hablemos de tu caso",
          "href": "https://wa.me/5215560501901",
          "sourceId": "apps/cano-penal/src/app/content.ts#site.whatsapp",
          "emphasis": "primary"
        }
      ]
    },
    {
      "path": "/explore",
      "navLabel": "Conoce",
      "purpose": "Establish a point of view before asking for action.",
      "capabilityIds": [
        "gallery",
        "media"
      ],
      "copyRoles": [
        "differentiators"
      ],
      "mediaRoles": [
        "documentary-context"
      ],
      "copy": [
        {
          "role": "differentiators",
          "text": "Soy abogado especialista en derecho penal. No soy generalista y aunque las conozco, no atiendo otras ramas del derecho. · Tu caso lo atiendo personalmente. La estrategia la diseño directamente, no la delego. · No hay intermediarios. Mantengo comunicación constante para que sepas en todo momento qué sucede con tu caso.",
          "sourceId": "nexus-grounded-copy:differentiators:a73bbe2e5955e8dd"
        }
      ],
      "media": [
        {
          "assetId": "audiencia-01",
          "role": "documentary-context",
          "publicPath": "/media/audiencia-01.jpg",
          "sourceDigest": "sha256:5b926250f817304ee55e1b6faf43d51eb336d309ae0984a8620cb6fe16af0578",
          "alt": "Fotografía publicada en la sección «En sala, en cada audiencia»."
        }
      ],
      "actions": []
    },
    {
      "path": "/proof",
      "navLabel": "Confianza",
      "purpose": "Accumulate evidence without converting it into tiles by default.",
      "capabilityIds": [
        "analytics"
      ],
      "copyRoles": [
        "credentials-and-proof",
        "proof"
      ],
      "mediaRoles": [
        "documentary-context",
        "proof-media"
      ],
      "copy": [
        {
          "role": "credentials-and-proof",
          "text": "Inicié en 2006 en el área de Delitos Fiscales y Financieros de la Procuraduría Fiscal de la Federación, y ascendí hasta dirigir esa misma área como Director de Investigaciones. Participé y gané los primeros juicios orales de defraudación fiscal a nivel nacional, con la sentencia de mayor cuantía a favor de la Secretaría de Hacienda.",
          "sourceId": "nexus-grounded-copy:credentials-and-proof:b5b4e0aadf97e795"
        },
        {
          "role": "proof",
          "text": "Inicié en 2006 en el área de Delitos Fiscales y Financieros de la Procuraduría Fiscal de la Federación, y ascendí hasta dirigir esa misma área como Director de Investigaciones. Participé y gané los primeros juicios orales de defraudación fiscal a nivel nacional, con la sentencia de mayor cuantía a favor de la Secretaría de Hacienda.",
          "sourceId": "nexus-grounded-copy:proof:b5b4e0aadf97e795"
        }
      ],
      "media": [
        {
          "assetId": "audiencia-01",
          "role": "documentary-context",
          "publicPath": "/media/audiencia-01.jpg",
          "sourceDigest": "sha256:5b926250f817304ee55e1b6faf43d51eb336d309ae0984a8620cb6fe16af0578",
          "alt": "Fotografía publicada en la sección «En sala, en cada audiencia»."
        },
        {
          "assetId": "hero-eduardo",
          "role": "proof-media",
          "publicPath": "/media/hero-eduardo.jpg",
          "sourceDigest": "sha256:2b018670fc1ad02f612bd13a7c3eff351442721ac51b31fa549255b541e8c3e0",
          "alt": "Retrato de Eduardo Cano de pie con los brazos cruzados."
        }
      ],
      "actions": []
    },
    {
      "path": "/visit",
      "navLabel": "Ubicación",
      "purpose": "Establish a point of view before asking for action.",
      "capabilityIds": [
        "location",
        "map"
      ],
      "copyRoles": [
        "location-and-hours"
      ],
      "mediaRoles": [
        "documentary-context"
      ],
      "copy": [
        {
          "role": "location-and-hours",
          "text": "Ubicación: World Trade Center Ciudad de México, Montecito 38, piso 28, oficina 16, colonia Nápoles, Benito Juárez, CDMX.",
          "sourceId": "nexus-grounded-copy:location-and-hours:b2e9333705f6be68"
        }
      ],
      "media": [
        {
          "assetId": "audiencia-01",
          "role": "documentary-context",
          "publicPath": "/media/audiencia-01.jpg",
          "sourceDigest": "sha256:5b926250f817304ee55e1b6faf43d51eb336d309ae0984a8620cb6fe16af0578",
          "alt": "Fotografía publicada en la sección «En sala, en cada audiencia»."
        }
      ],
      "actions": []
    },
    {
      "path": "/contact",
      "navLabel": "Contacto",
      "purpose": "Offer a next step only after context exists.",
      "capabilityIds": [
        "contact",
        "whatsapp",
        "forms"
      ],
      "copyRoles": [
        "primary-cta",
        "qualification-and-contact"
      ],
      "mediaRoles": [],
      "copy": [
        {
          "role": "primary-cta",
          "text": "Hablemos de tu caso",
          "sourceId": "nexus-grounded-copy:primary-cta:c08047a0718027fb"
        },
        {
          "role": "qualification-and-contact",
          "text": "Teléfono: 55 6050 1901. Dirección: World Trade Center Ciudad de México, Montecito 38, piso 28, oficina 16, colonia Nápoles, Benito Juárez, CDMX.",
          "sourceId": "nexus-grounded-copy:qualification-and-contact:e09dd1b02389805c"
        }
      ],
      "media": [],
      "actions": [
        {
          "capabilityId": "whatsapp",
          "label": "Hablemos de tu caso",
          "href": "https://wa.me/5215560501901",
          "sourceId": "apps/cano-penal/src/app/content.ts#site.whatsapp",
          "emphasis": "primary"
        }
      ]
    }
  ],
  "copy": [
    {
      "role": "credentials-and-proof",
      "text": "Inicié en 2006 en el área de Delitos Fiscales y Financieros de la Procuraduría Fiscal de la Federación, y ascendí hasta dirigir esa misma área como Director de Investigaciones. Participé y gané los primeros juicios orales de defraudación fiscal a nivel nacional, con la sentencia de mayor cuantía a favor de la Secretaría de Hacienda.",
      "sourceId": "nexus-grounded-copy:credentials-and-proof:b5b4e0aadf97e795"
    },
    {
      "role": "differentiators",
      "text": "Soy abogado especialista en derecho penal. No soy generalista y aunque las conozco, no atiendo otras ramas del derecho. · Tu caso lo atiendo personalmente. La estrategia la diseño directamente, no la delego. · No hay intermediarios. Mantengo comunicación constante para que sepas en todo momento qué sucede con tu caso.",
      "sourceId": "nexus-grounded-copy:differentiators:a73bbe2e5955e8dd"
    },
    {
      "role": "headline",
      "text": "CANO Estrategia Penal",
      "sourceId": "nexus-grounded-copy:headline:5fcf859001675aa7"
    },
    {
      "role": "location-and-hours",
      "text": "Ubicación: World Trade Center Ciudad de México, Montecito 38, piso 28, oficina 16, colonia Nápoles, Benito Juárez, CDMX.",
      "sourceId": "nexus-grounded-copy:location-and-hours:b2e9333705f6be68"
    },
    {
      "role": "primary-cta",
      "text": "Hablemos de tu caso",
      "sourceId": "nexus-grounded-copy:primary-cta:c08047a0718027fb"
    },
    {
      "role": "proof",
      "text": "Inicié en 2006 en el área de Delitos Fiscales y Financieros de la Procuraduría Fiscal de la Federación, y ascendí hasta dirigir esa misma área como Director de Investigaciones. Participé y gané los primeros juicios orales de defraudación fiscal a nivel nacional, con la sentencia de mayor cuantía a favor de la Secretaría de Hacienda.",
      "sourceId": "nexus-grounded-copy:proof:b5b4e0aadf97e795"
    },
    {
      "role": "qualification-and-contact",
      "text": "Teléfono: 55 6050 1901. Dirección: World Trade Center Ciudad de México, Montecito 38, piso 28, oficina 16, colonia Nápoles, Benito Juárez, CDMX.",
      "sourceId": "nexus-grounded-copy:qualification-and-contact:e09dd1b02389805c"
    },
    {
      "role": "value-proposition",
      "text": "Despacho especializado en derecho penal en Ciudad de México.",
      "sourceId": "nexus-grounded-copy:value-proposition:5cfcff9fd1ae0305"
    }
  ],
  "media": [
    {
      "assetId": "audiencia-01",
      "role": "documentary-context",
      "publicPath": "/media/audiencia-01.jpg",
      "sourceDigest": "sha256:5b926250f817304ee55e1b6faf43d51eb336d309ae0984a8620cb6fe16af0578",
      "alt": "Fotografía publicada en la sección «En sala, en cada audiencia»."
    },
    {
      "assetId": "eduardo-cano-desk",
      "role": "hero-media",
      "publicPath": "/media/eduardo-cano-escritorio.jpg",
      "sourceDigest": "sha256:c2f01018d086287e9f4a496ed93c9924d16dad7c8990f919b245208c5809d3b3",
      "alt": "Eduardo Cano en su escritorio."
    },
    {
      "assetId": "hero-eduardo",
      "role": "proof-media",
      "publicPath": "/media/hero-eduardo.jpg",
      "sourceDigest": "sha256:2b018670fc1ad02f612bd13a7c3eff351442721ac51b31fa549255b541e8c3e0",
      "alt": "Retrato de Eduardo Cano de pie con los brazos cruzados."
    }
  ],
  "dnaSubject": "CANO Estrategia Penal",
  "recipeId": "editorial-sequence"
};
