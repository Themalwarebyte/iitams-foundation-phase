import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      eslintConfigPrettier,
    ],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    // Stock shadcn/ui primitives: the init-shipped implementations of
    // useIsMobile, SidebarSkeleton and the embla carousel deliberately
    // initialise state from media queries / props inside effects. The
    // react-compiler-style diagnostics flag these idiomatically-correct
    // patterns; relaxing here documents the exception without weakening the
    // rules for application code.
    files: [
      "src/components/ui/carousel.tsx",
      "src/components/ui/sidebar.tsx",
      "src/hooks/use-mobile.ts",
    ],
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
    },
  },
);
