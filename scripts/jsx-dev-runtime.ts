/**
 * The development JSX runtime the binary resolves in place of React's. The
 * renderer's packages ship compiled to jsxDEV, and React's production build
 * of `react/jsx-dev-runtime` leaves jsxDEV undefined; this one hands each
 * element to the production jsx, which takes the same type, props and key.
 */
import { Fragment, jsx } from "react/jsx-runtime";

export { Fragment };

export function jsxDEV(
  type: Parameters<typeof jsx>[0],
  props: Parameters<typeof jsx>[1],
  key?: Parameters<typeof jsx>[2],
): ReturnType<typeof jsx> {
  return jsx(type, props, key);
}
