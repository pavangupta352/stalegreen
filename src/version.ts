declare const __STALEGREEN_VERSION__: string | undefined;

/** Package version, injected at build time. */
export const VERSION: string = typeof __STALEGREEN_VERSION__ === "string" ? __STALEGREEN_VERSION__ : "0.0.0-dev";
