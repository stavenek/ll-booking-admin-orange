const globals = require("globals");

module.exports = [
  {
    files: ["app.js"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "script",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none" }],
      "no-undef": "error",
      "no-redeclare": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-unreachable": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      eqeqeq: ["warn", "smart"],
    },
  },
];
