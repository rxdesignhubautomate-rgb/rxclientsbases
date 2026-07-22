import js from "@eslint/js";

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "migration-reports/**", "frontend/dist/**"]
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        Blob: "readonly",
        Buffer: "readonly",
        FormData: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setImmediate: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        structuredClone: "readonly"
      }
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" }]
    }
  },
  {
    files: ["frontend/src/**/*.js"],
    languageOptions: {
      globals: {
        URLSearchParams: "readonly",
        confirm: "readonly",
        document: "readonly",
        localStorage: "readonly",
        location: "readonly",
        window: "readonly"
      }
    }
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      globals: {
        describe: "readonly",
        expect: "readonly",
        it: "readonly",
        vi: "readonly"
      }
    }
  }
];
