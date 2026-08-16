// The individual logo components are intentionally NOT re-exported: every
// consumer goes through `brandLogoFor`, which is the only thing that knows the
// provider→logo mapping. `brand-logo-for.ts` imports them straight from
// `./BrandLogo`.
export type { BrandLogoProps } from "./BrandLogo";
export { brandLogoFor } from "./brand-logo-for";
