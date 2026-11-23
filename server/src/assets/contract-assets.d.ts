// The files of contract/assets, imported as text (`with { type: "text" }`):
// both servers embed the same bytes.
declare module "*.py" {
  const text: string;
  export default text;
}
declare module "*.sh" {
  const text: string;
  export default text;
}
declare module "*.ps1" {
  const text: string;
  export default text;
}
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*/rendered-helper.js" {
  const text: string;
  export default text;
}
