// Ambient declarations for CSS side-effect and CSS-module imports.
//
// `vite/client` (referenced from tsconfig.json `types`) already declares
// `*.css` and `*.module.css`. This file is defence-in-depth: if a future
// tsconfig change ever drops the vite/client reference, side-effect
// `import "./foo.css"` and `import styles from "./foo.module.css"` keep
// type-checking instead of erroring TS2882 / TS2307.

declare module "*.css";

declare module "*.module.css" {
	const classes: Record<string, string>;
	export default classes;
}
