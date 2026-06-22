/// <reference types="vite/client" />

// Injected by vite.config.ts `define` (see there). __APP_VERSION__ is the
// package.json semver; __BUILD_REV__ is the short git rev (+ `+` when dirty).
declare const __APP_VERSION__: string;
declare const __BUILD_REV__: string;
