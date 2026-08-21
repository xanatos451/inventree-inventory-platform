const globals = require("globals");

// Catches unreachable/orphaned code (no-unused-vars) and flags files or
// functions growing back into unmanageable monoliths (max-lines[-per-function]).
module.exports = [
  {
    files: ["**/*.js"],
    ignores: ["node_modules/**", "tests/**", "eslint.config.js", "playwright.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "max-lines": ["warn", { max: 600, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 200, skipBlankLines: true, skipComments: true }]
    }
  },
  {
    // Page-injected scrapers are inherently long single functions; allow more room.
    files: ["background/scrapers/**/*.js"],
    rules: {
      "max-lines": ["warn", { max: 900, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 900, skipBlankLines: true, skipComments: true }]
    }
  }
];
