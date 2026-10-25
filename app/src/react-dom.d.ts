/** The one react-dom function the website uses (react-dom is a dependency; its types are not installed). */
declare module 'react-dom' {
  export function flushSync<R>(update: () => R): R;
}
