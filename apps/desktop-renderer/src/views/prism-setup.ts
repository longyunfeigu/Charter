// @lexical/code (via @mdxeditor/editor) expects a global `Prism` at runtime —
// the prismjs UMD/ESM interop gap. Evaluated before the editor module loads.
// prismjs ships no types; it is a transitive dep we only need as a global.
// @ts-expect-error -- untyped transitive module, used for its side value only
import Prism from 'prismjs';

const scope = globalThis as { Prism?: unknown };
if (!scope.Prism) scope.Prism = Prism;

export {};
