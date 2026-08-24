declare module 'picomatch' {
  interface Matcher { (input: string): boolean }
  function pm(glob: string | ReadonlyArray<string>, options?: object): Matcher;
  export default pm;
}
