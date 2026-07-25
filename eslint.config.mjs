import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "drizzle/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Drizzle's `globalThis.__db` connection-reuse pattern needs `var`.
      "no-var": "off",
      // Non-null assertions are used deliberately against Google API types,
      // where the generated schemas mark practically everything optional.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
]

export default config;
