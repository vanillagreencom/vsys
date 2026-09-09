import type { KeyEvent } from "@opentui/core";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";

/** Returns true when the screen consumed the key, so the shell leaves it alone. */
export type KeyHandler = (name: string, key: KeyEvent) => boolean;
interface Registry {
  register(handler: KeyHandler): () => void;
}
const Context = createContext<Registry | null>(null);

/**
 * The shell owns the one keyboard subscription. A screen registers a handler
 * here and sees each key before the shell's own bindings, so a search box or
 * an editor can take every key while it is open.
 */
export function KeyProvider({
  handlers,
  children,
}: {
  handlers: Set<KeyHandler>;
  children: ReactNode;
}) {
  const value = useMemo<Registry>(
    () => ({
      register(handler) {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    }),
    [handlers],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useScreenKeys(handler: KeyHandler): void {
  const registry = useContext(Context);
  if (!registry) throw new Error("useScreenKeys needs a KeyProvider");
  const current = useRef(handler);
  current.current = handler;
  useEffect(
    () => registry.register((name, key) => current.current(name, key)),
    [registry],
  );
}
