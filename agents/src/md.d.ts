// Identity files are imported as text modules. See the Text rule in wrangler.jsonc.
declare module '*.md' {
  const content: string;
  export default content;
}
