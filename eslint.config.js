import js from "@eslint/js";

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "migration-reports/**", "frontend/dist/**", "frontend/src/jspdf.umd.min.js", "frontend/src/lame.min.js", "frontend/src/vendor/**"]
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
        , Event: 'readonly', EventTarget: 'readonly'
      }
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" }]
    }
  },
  {
    files: ["frontend/src/**/*.js", "frontend/src/**/*.mjs"],
    languageOptions: {
      globals: {
        URLSearchParams: "readonly",
        confirm: "readonly",
        document: "readonly",
        localStorage: "readonly",
        location: "readonly",
        window: "readonly"
        , Option: 'readonly'
        , AbortSignal: 'readonly', btoa: 'readonly', requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', prompt: 'readonly', navigator: 'readonly', MediaRecorder: 'readonly', File: 'readonly', Notification: 'readonly', Worker: 'readonly', indexedDB: 'readonly', crypto: 'readonly'
      }
    }
  },
  { files: ['frontend/src/audio-encoder.js'], languageOptions: { globals: { self: 'readonly', importScripts: 'readonly', lamejs: 'readonly' } } },
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
