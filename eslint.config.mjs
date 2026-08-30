import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";



const restrictedCoreImports = [
  {
    name: "@nexus/experimental",
    message: "Core must never depend on Experimental.",
  },
  {
    name: "@nexus/experimental/*",
    message: "Core must never depend on Experimental.",
  },
  {
    name: "@nexus/experience",
    message: "Core must never depend on Experience Engine.",
  },
  {
    name: "@nexus/experience/*",
    message: "Core must never depend on Experience Engine.",
  },
  {
    name: "@nexus/reference-alfil",
    message: "Core must never depend on a Client Experience app.",
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "runtime/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "**/dist/**",
      "**/coverage/**",
      "*.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    files: ["packages/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: restrictedCoreImports,
          patterns: [
            { group: ["@nexus/experimental", "@nexus/experimental/*"], message: "Core must never import Experimental." },
            { group: ["@nexus/experience", "@nexus/experience/*"], message: "Core must never import Experience Engine." },
            { group: ["../../../apps/*", "../../../../apps/*"], message: "Core must never import Client Experience." },
            { group: ["../../experimental/*", "../../../experimental/*", "../../experience/*", "../../../experience/*"], message: "Core must never import Experimental or Experience Engine through relative paths." }
          ]
        }
      ]
    }
  },
  {
    files: ["packages/core/foundation/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: restrictedCoreImports,
          patterns: [
            { group: ["@nexus/experimental", "@nexus/experimental/*", "@nexus/experience", "@nexus/experience/*", "../../../apps/*", "../../../../apps/*", "../../experimental/*", "../../../experimental/*", "../../experience/*", "../../../experience/*"], message: "Foundation must not import apps, Experimental or Experience Engine." },
            {
              group: [
                "@nexus/core/data/*",
                "@nexus/core/motion/*",
                "@nexus/core/components/*",
                "@nexus/core/composition/*",
                "@nexus/core/a11y/*",
                "../../data/*",
                "../../motion/*",
                "../../components/*",
                "../../composition/*",
                "../../a11y/*",
              ],
              message:
                "Foundation is the base layer and must not import higher Core layers.",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["packages/experience/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "Experience Engine contracts must remain implementation-agnostic." },
            { name: "next", message: "Experience Engine contracts must remain framework-agnostic." },
            { name: "@nexus/core", message: "Experience Engine plans intent; implementation may consume Core later." }
          ],
          patterns: [
            { group: ["react/*", "next/*", "@nexus/core/*", "../../apps/*", "../../../apps/*"], message: "Experience Engine must not import implementation or app code." }
          ]
        }
      ]
    }
  },
  {
    files: ["*.config.{js,mjs,cjs,ts}", "**/*.config.{js,mjs,cjs,ts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
